"use strict";

// References:
// - Anthropic API overview, URL shape, and auth headers:
//   https://platform.claude.com/docs/en/api/overview

const { anthropicToOpenAI, openAIToAnthropic, pipeOpenAIStreamAsAnthropic } = require("./openai-adapter");

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
    if (modelRoute.remoteProtocol === "openai") {
      sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "OpenAI 后端只支持 JSON 请求体。" } });
      return;
    }
    await pipeRemoteResponse(req, res, modelRoute, route, req, logger);
    return;
  }

  const bodyBuffer = await readBody(req, MAX_JSON_BODY_BYTES);
  let body = null;
  let modelRoute = resolveDefaultRoute(config);
  let remoteBody = bodyBuffer;

  if (bodyBuffer.length > 0) {
    body = parseJsonBody(bodyBuffer);

    // Routing: use the top-level model field only to pick the backend.
    // This avoids spurious "multi-model conflict" errors when nested structures
    // (e.g. agent subagent configs) carry a different model name.
    const primaryModelName = typeof body.model === "string" ? body.model : null;
    if (primaryModelName) {
      try {
        modelRoute = resolveModel(config, primaryModelName);
      } catch (error) {
        sendJson(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: error.message }
        });
        return;
      }
    } else {
      // No top-level model field — fall back to scanning nested fields
      const modelNames = collectModelNames(body);
      if (modelNames.length > 0) {
        try {
          modelRoute = resolveModel(config, modelNames[0]);
        } catch (error) {
          sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: error.message }
          });
          return;
        }
      }
    }

    // Rewriting: remap ALL model fields in the body.
    // Cross-backend models (nested) are rewritten to the primary route's remoteModelId.
    const allModelNames = collectModelNames(body);
    if (allModelNames.length > 0) {
      const modelMap = buildModelMap(config, allModelNames, modelRoute, resolveModel);
      remoteBody = Buffer.from(JSON.stringify(rewriteModelNames(body, modelMap)));
    }
  }

  if (modelRoute.remoteProtocol === "openai") {
    await forwardAnthropicToOpenAI(req, res, modelRoute, body || {}, logger);
    return;
  }

  await pipeRemoteResponse(req, res, modelRoute, route, remoteBody, logger);
}

async function forwardAnthropicToOpenAI(req, res, modelRoute, anthropicBody, logger) {
  const isStream = Boolean(anthropicBody.stream);
  const openAIBody = anthropicToOpenAI(anthropicBody, modelRoute.remoteModelId);
  const remoteUrl = `${modelRoute.remoteBaseUrl}/v1/chat/completions`;

  await logger?.debug("转发到 OpenAI 后端", {
    method: "POST",
    remoteUrl,
    sourceModel: modelRoute.source,
    targetModel: modelRoute.remoteModelId,
    stream: isStream
  });

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${modelRoute.remoteApiKey}`
  };

  const remoteResponse = await fetch(remoteUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(openAIBody)
  });

  await logger?.debug("收到 OpenAI 后端响应", {
    remoteUrl,
    status: remoteResponse.status,
    statusText: remoteResponse.statusText
  });

  if (!remoteResponse.ok) {
    const errText = await remoteResponse.text().catch(() => "");
    sendJson(res, remoteResponse.status, {
      type: "error",
      error: { type: "api_error", message: `上游 OpenAI 后端返回错误 ${remoteResponse.status}：${errText}` }
    });
    return;
  }

  if (isStream) {
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-accel-buffering", "no");
    res.writeHead(200);
    await pipeOpenAIStreamAsAnthropic(remoteResponse.body, res, modelRoute.source);
    res.end();
    return;
  }

  const oaiJson = await remoteResponse.json();
  const anthropicResponse = openAIToAnthropic(oaiJson, modelRoute.source);
  sendJson(res, 200, anthropicResponse);
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
    source: mapping.localModelId,
    remoteModelId: mapping.remoteModelId,
    remoteBaseUrl: mapping.remoteBaseUrl,
    remoteApiKey: Object.prototype.hasOwnProperty.call(mapping, "remoteApiKey") ? mapping.remoteApiKey || "" : "",
    remoteProtocol: mapping.remoteProtocol || "anthropic"
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

/**
 * Build a model-name → remoteModelId map for all model names found in the body.
 * Models that resolve to the same backend as primaryRoute are rewritten to their own
 * remoteModelId; models from a different backend are rewritten to primaryRoute's
 * remoteModelId so the upstream never sees an alien model name.
 */
function buildModelMap(config, modelNames, primaryRoute, resolveModel) {
  const modelMap = new Map();

  for (const modelName of new Set(modelNames)) {
    let route;
    try {
      route = resolveModel(config, modelName);
    } catch {
      route = primaryRoute;
    }

    const sameBackend =
      route.remoteBaseUrl === primaryRoute.remoteBaseUrl && route.remoteApiKey === primaryRoute.remoteApiKey;

    modelMap.set(modelName, sameBackend ? route.remoteModelId : primaryRoute.remoteModelId);
  }

  return modelMap;
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

async function forwardImageRequest(req, res, imageRoute, parsedBody, logger) {
  const body = { ...(parsedBody || {}) };

  // Override model with the resolved remoteModelId
  body.model = imageRoute.remoteModelId;

  const remoteUrl = `${imageRoute.remoteBaseUrl}/v1/images/generations`;

  await logger?.debug("转发图片生成请求", { remoteUrl, model: imageRoute.remoteModelId });

  const remoteResponse = await fetch(remoteUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${imageRoute.remoteApiKey}`
    },
    body: JSON.stringify(body)
  });

  await logger?.debug("图片生成响应", { status: remoteResponse.status });

  const responseBody = await remoteResponse.text();
  res.setHeader("content-type", "application/json");
  res.writeHead(remoteResponse.status);
  res.end(responseBody);
}

module.exports = {
  forwardAnthropicRequest,
  forwardImageRequest
};
