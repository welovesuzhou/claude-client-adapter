"use strict";

// References:
// - Anthropic API overview, URL shape, and auth headers:
//   https://platform.claude.com/docs/en/api/overview

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

const MB = 1024 * 1024;
const MAX_JSON_BODY_BYTES = 500 * MB;

function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("请求体太大。"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function readJsonBody(req, maxBytes = 20 * 1024 * 1024) {
  return readBody(req, maxBytes).then((body) => parseJsonBody(body));
}

function parseJsonBody(bodyBuffer) {
  const raw = bodyBuffer.toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法的 JSON：${error.message}`), { statusCode: 400 });
  }
}

function buildForwardHeaders(req, modelRoute) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      continue;
    }

    if (Array.isArray(value)) {
      headers[lowerKey] = value.join(", ");
    } else if (value !== undefined) {
      headers[lowerKey] = value;
    }
  }

  replaceApiKeyHeader(headers, modelRoute.remoteApiKey);
  return headers;
}

function replaceApiKeyHeader(headers, remoteApiKey) {
  const hasAuthHeader = Array.from(AUTH_HEADERS).some((headerName) =>
    Object.prototype.hasOwnProperty.call(headers, headerName)
  );

  if (!hasAuthHeader) {
    return headers;
  }

  const originalAuthHeaders = {};
  for (const headerName of AUTH_HEADERS) {
    if (Object.prototype.hasOwnProperty.call(headers, headerName)) {
      originalAuthHeaders[headerName] = true;
      delete headers[headerName];
    }
  }

  if (!remoteApiKey) {
    return headers;
  }

  if (originalAuthHeaders.authorization) {
    headers.authorization = `Bearer ${remoteApiKey}`;
  }
  if (originalAuthHeaders["x-api-key"]) {
    headers["x-api-key"] = remoteApiKey;
  }
  if (originalAuthHeaders["api-key"]) {
    headers["api-key"] = remoteApiKey;
  }

  return headers;
}

async function forwardAnthropicRequest(req, res, config, route, resolveModel, logger) {
  const contentType = String(req.headers["content-type"] || "");
  const jsonLike = contentType.includes("application/json");

  if (!jsonLike) {
    const modelRoute = resolveDefaultRoute(config);
    await pipeRemoteResponse(req, res, modelRoute, route, req, logger);
    return;
  }

  const bodyBuffer = await readBody(req, MAX_JSON_BODY_BYTES);
  let body = null;
  let modelRoute = resolveDefaultRoute(config);
  let remoteBody = bodyBuffer;

  if (bodyBuffer.length > 0) {
    body = parseJsonBody(bodyBuffer);
    const modelNames = collectModelNames(body);

    if (modelNames.length > 0) {
      const rewrite = resolveModelRewrite(config, modelNames, resolveModel);
      if (rewrite.error) {
        sendJson(res, rewrite.statusCode, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: rewrite.error
          }
        });
        await logger?.debug("模型映射失败", {
          method: req.method,
          route,
          error: rewrite.error
        });
        return;
      }

      modelRoute = rewrite.modelRoute;
      remoteBody = Buffer.from(JSON.stringify(rewriteModelNames(body, rewrite.modelMap)));
    }
  }

  await pipeRemoteResponse(req, res, modelRoute, route, remoteBody, logger);
}

async function pipeRemoteResponse(req, res, modelRoute, route, body, logger) {
  const method = String(req.method || "").toUpperCase();
  const remoteBody = method === "GET" || method === "HEAD" ? undefined : body;
  const remoteUrl = `${modelRoute.remoteBaseUrl}${route}`;

  await logger?.debug("开始转发请求", {
    method: req.method,
    remoteUrl,
    sourceModel: modelRoute.source,
    targetModel: modelRoute.remoteModelId,
    hasBody: Boolean(remoteBody)
  });

  const remoteResponse = await fetch(remoteUrl, {
    method: req.method,
    headers: buildForwardHeaders(req, modelRoute),
    body: remoteBody,
    duplex: remoteBody && typeof remoteBody.pipe === "function" ? "half" : undefined,
    redirect: "manual"
  });

  await logger?.debug("收到远程模型响应", {
    method: req.method,
    remoteUrl,
    status: remoteResponse.status,
    statusText: remoteResponse.statusText
  });

  copyResponseHeaders(remoteResponse.headers, res);
  res.statusMessage = remoteResponse.statusText || res.statusMessage;
  res.writeHead(remoteResponse.status);

  if (!remoteResponse.body) {
    res.end();
    return;
  }

  try {
    for await (const chunk of remoteResponse.body) {
      if (res.destroyed) {
        break;
      }
      res.write(Buffer.from(chunk));
    }
  } catch (error) {
    await logger?.debug("读取远程模型响应失败", {
      method: req.method,
      remoteUrl,
      error: error.message
    });
    if (!res.destroyed) {
      res.destroy(error);
    }
    return;
  }

  if (!res.destroyed) {
    res.end();
  }
}

function resolveDefaultRoute(config) {
  const mapping = config.models?.find((model) => model.enabled !== false);
  if (!mapping) {
    throw Object.assign(new Error("还没有配置任何模型映射。"), { statusCode: 503 });
  }

  return {
    source: mapping.localModel,
    remoteModelId: mapping.remoteModelId,
    remoteBaseUrl: mapping.remoteBaseUrl,
    remoteApiKey: Object.prototype.hasOwnProperty.call(mapping, "remoteApiKey") ? mapping.remoteApiKey || "" : ""
  };
}

function copyResponseHeaders(headers, res) {
  for (const [key, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    if (key.toLowerCase() === "set-cookie" && typeof headers.getSetCookie === "function") {
      continue;
    }
    res.setHeader(key, value);
  }

  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      res.setHeader("set-cookie", cookies);
    }
  }
}

function collectModelNames(value, models = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelNames(item, models);
    }
    return models;
  }

  if (!value || typeof value !== "object") {
    return models;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "model" && typeof child === "string") {
      models.push(child);
    } else {
      collectModelNames(child, models);
    }
  }

  return models;
}

function resolveModelRewrite(config, modelNames, resolveModel) {
  const modelMap = new Map();
  let selectedRoute = null;

  for (const modelName of new Set(modelNames)) {
    let route;
    try {
      route = resolveModel(config, modelName);
    } catch (error) {
      return { error: error.message, statusCode: 400 };
    }

    if (
      selectedRoute &&
      (selectedRoute.remoteBaseUrl !== route.remoteBaseUrl || selectedRoute.remoteApiKey !== route.remoteApiKey)
    ) {
      return {
        error: "这个请求里包含多个模型，但它们映射到了不同的远程模型服务。请拆成多个请求发送。",
        statusCode: 400
      };
    }

    selectedRoute = selectedRoute || route;
    modelMap.set(modelName, route.remoteModelId);
  }

  return {
    modelRoute: selectedRoute,
    modelMap
  };
}

function rewriteModelNames(value, modelMap) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteModelNames(item, modelMap));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const rewritten = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "model" && typeof child === "string" && modelMap.has(child)) {
      rewritten[key] = modelMap.get(child);
    } else {
      rewritten[key] = rewriteModelNames(child, modelMap);
    }
  }

  return rewritten;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

module.exports = {
  forwardAnthropicRequest
};
