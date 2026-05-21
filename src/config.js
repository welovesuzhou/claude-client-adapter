"use strict";

// References:
// - Anthropic API overview for the default API version and per-model routing remoteModelId:
//   https://platform.claude.com/docs/en/api/overview

const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = "config.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18787;

function parseArgs(argv) {
  const args = {
    configPath: DEFAULT_CONFIG_PATH
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      args.configPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--config=")) {
      args.configPath = arg.slice("--config=".length);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }

  return args;
}

async function loadRuntimeConfig(args) {
  return loadConfig(args.configPath);
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  let raw;

  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const notFound = new Error(`找不到配置文件：${resolvedPath}`);
      notFound.code = "ENOENT";
      throw notFound;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是合法的 JSON：${resolvedPath}。${error.message}`);
  }

  return normalizeConfig(parsed, resolvedPath);
}

async function loadOptionalConfig(configPath) {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);

  try {
    return {
      config: await loadConfig(resolvedPath),
      configPath: resolvedPath,
      error: null
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeStarterConfig(resolvedPath);
      return {
        config: null,
        configPath: resolvedPath,
        error: new Error("已自动创建 config.json，请在网页里填写远程模型信息。")
      };
    }

    return {
      config: null,
      configPath: resolvedPath,
      error
    };
  }
}

async function saveSimpleConfig(configPath, input, currentConfig) {
  return saveWebConfig(
    configPath,
    {
      models: [
        {
          localModelId: input.localModelId || "claude",
          remoteBaseUrl: input.remoteBaseUrl,
          remoteApiKey: input.remoteApiKey,
          remoteModelId: input.remoteModelId
        }
      ],
      host: input.host,
      port: input.port
    },
    currentConfig
  );
}

async function saveWebConfig(configPath, input, currentConfig) {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const models = normalizeWebModelInputs(input.models, currentConfig);

  const rawConfig = {
    listen: {
      host: input.host || currentConfig?.listen?.host || DEFAULT_HOST,
      port: Number(input.port || currentConfig?.listen?.port || DEFAULT_PORT)
    },
    debug: typeof input.debug === "boolean" ? input.debug : currentConfig?.debug === true,
    models: models.map((model) => ({
      localModelId: model.localModelId,
      remoteModelId: model.remoteModelId,
      remoteBaseUrl: model.remoteBaseUrl,
      remoteApiKey: model.remoteApiKey,
      enabled: model.enabled
    }))
  };

  const normalized = normalizeConfig(rawConfig, resolvedPath);
  await fs.writeFile(resolvedPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
  return normalized;
}

function publicConfig(config, configPath, error) {
  const models = publicModelConfigs(config);
  return {
    configured: Boolean(config && models.some((model) => model.enabled !== false)),
    configPath,
    error: error ? error.message : null,
    host: config?.listen?.host || DEFAULT_HOST,
    port: config?.listen?.port || DEFAULT_PORT,
    localBaseUrl: `http://${config?.listen?.host || DEFAULT_HOST}:${config?.listen?.port || DEFAULT_PORT}`,
    models
  };
}

function publicModelConfigs(config) {
  if (!config) {
    return [];
  }

  return config.models.map((mapping) => ({
    localModelId: mapping.localModelId,
    remoteBaseUrl: mapping.remoteBaseUrl || "",
    remoteModelId: mapping.remoteModelId,
    remoteApiKey: modelApiKey(mapping),
    hasApiKey: Boolean(modelApiKey(mapping)),
    enabled: mapping.enabled
  }));
}

function normalizeWebModelInputs(modelInputs, currentConfig) {
  if (!Array.isArray(modelInputs)) {
    throw new Error("模型配置格式不正确。");
  }

  const models = [];
  const seen = new Set();

  for (const input of modelInputs) {
    const localModelId = String(input.localModelId || "").trim();
    const originalLocalModelId = String(input.originalLocalModelId || localModelId).trim();
    let remoteBaseUrl = String(input.remoteBaseUrl || "").trim();
    let remoteModelId = String(input.remoteModelId || "").trim();
    const remoteApiKey = String(input.remoteApiKey || "").trim();
    const enabled = input.enabled !== false;

    if (looksLikeHttpUrl(remoteModelId) && !looksLikeHttpUrl(remoteBaseUrl)) {
      [remoteBaseUrl, remoteModelId] = [remoteModelId, remoteBaseUrl];
    }

    if (!localModelId) {
      throw new Error("请填写本地模型名。");
    }
    if (seen.has(localModelId)) {
      throw new Error(`模型名重复：${localModelId}`);
    }
    if (!remoteBaseUrl) {
      throw new Error(`请填写 ${localModelId} 的 remoteBaseUrl。`);
    }
    if (!looksLikeHttpUrl(remoteBaseUrl)) {
      throw new Error(`模型 "${localModelId}" 的 remoteBaseUrl 必须以 http:// 或 https:// 开头。`);
    }
    if (!remoteModelId) {
      throw new Error(`请填写 ${localModelId} 的 remoteModelId。`);
    }

    seen.add(localModelId);
    models.push({
      localModelId,
      remoteBaseUrl: stripTrailingSlash(remoteBaseUrl),
      remoteModelId,
      remoteApiKey,
      enabled
    });
  }

  return models;
}

function findExistingModel(config, localModelId) {
  if (!config || !localModelId) {
    return null;
  }

  const mapping = config.models.find((model) => model.localModelId === localModelId);
  if (!mapping) {
    return null;
  }

  return {
    remoteBaseUrl: mapping.remoteBaseUrl || "",
    remoteApiKey: modelApiKey(mapping),
    remoteModelId: mapping.remoteModelId
  };
}

async function writeStarterConfig(configPath) {
  const starterConfig = {
    listen: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT
    },
    debug: false,
    models: []
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(starterConfig, null, 2)}\n`, "utf8");
}

function normalizeConfig(input, configPath) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("配置文件内容必须是一个 JSON 对象。");
  }

  const models = input.models || [];
  const debug = input.debug === true || input.logging?.debug === true;

  const port = Number(input.listen?.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("配置字段 listen.port 必须是有效端口号。");
  }

  return {
    configPath,
    listen: {
      host: input.listen?.host || DEFAULT_HOST,
      port
    },
    debug,
    models: normalizeModels(models),
    imageModels: normalizeImageModels(input.imageModels || [])
  };
}

function normalizeImageModels(imageModels) {
  if (!Array.isArray(imageModels)) return [];
  return imageModels
    .filter((m) => m && typeof m === "object" && m.enabled !== false)
    .map((m) => ({
      id: String(m.id || "").trim(),
      remoteModelId: String(m.remoteModelId || m.id || "").trim(),
      remoteBaseUrl: stripTrailingSlash(String(m.remoteBaseUrl || "").trim()),
      remoteApiKey: String(m.remoteApiKey || "").trim()
    }))
    .filter((m) => m.id && m.remoteBaseUrl);
}

function resolveImageModel(config, modelId) {
  const imageModels = config.imageModels || [];
  const match = imageModels.find((m) => m.id === modelId) || imageModels[0];
  if (!match) throw Object.assign(new Error("没有配置任何图片生成模型。"), { statusCode: 503 });
  return match;
}

function normalizeModels(models) {
  if (Array.isArray(models)) {
    return normalizeModelArray(models);
  }

  if (!models || typeof models !== "object") {
    throw new Error("配置字段 models 必须是数组。");
  }

  return normalizeModelArray(
    Object.entries(models).map(([source, value]) => {
      if (typeof value === "string") {
        return {
          localModelId: source,
          remoteModelId: value
        };
      }

      return {
        localModelId: source,
        ...value
      };
    })
  );
}

function normalizeModelArray(models) {
  const normalized = [];
  const seen = new Set();

  for (const value of models) {
    if (typeof value === "string") {
      throw new Error("models 数组里的每一项都必须是对象。");
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("models 数组里的每一项都必须是对象。");
    }

    const localModelId = String(value.localModelId || value.source || value.model || "").trim();
    if (!localModelId) {
      throw new Error("models 数组里的每一项都必须包含 localModelId。");
    }

    if (seen.has(localModelId)) {
      throw new Error(`模型名重复：${localModelId}`);
    }

    let remoteModelId = value.remoteModelId;
    let remoteBaseUrl = value.remoteBaseUrl;

    if (looksLikeHttpUrl(remoteModelId) && !looksLikeHttpUrl(remoteBaseUrl)) {
      [remoteBaseUrl, remoteModelId] = [remoteModelId, remoteBaseUrl];
    }

    if (!remoteModelId || typeof remoteModelId !== "string") {
      throw new Error(`模型 "${localModelId}" 的映射必须包含 remoteModelId。`);
    }

    if (!remoteBaseUrl || typeof remoteBaseUrl !== "string") {
      throw new Error(`模型 "${localModelId}" 的映射必须包含 remoteBaseUrl。`);
    }
    if (!looksLikeHttpUrl(remoteBaseUrl)) {
      throw new Error(`模型 "${localModelId}" 的 remoteBaseUrl 必须以 http:// 或 https:// 开头。`);
    }

    const normalizedMapping = {
      localModelId,
      remoteModelId,
      remoteBaseUrl: stripTrailingSlash(remoteBaseUrl),
      enabled: value.enabled !== false
    };

    if (Object.prototype.hasOwnProperty.call(value, "remoteApiKey")) {
      normalizedMapping.remoteApiKey = value.remoteApiKey || "";
    }

    if (value.remoteProtocol === "openai") {
      normalizedMapping.remoteProtocol = "openai";
    }

    seen.add(localModelId);
    normalized.push(normalizedMapping);
  }

  return normalized;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function looksLikeHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function resolveModel(config, requestedModel) {
  const enabledModels = config.models.filter((model) => model.enabled !== false);
  const mapping = enabledModels.find((model) => model.localModelId === requestedModel) || enabledModels[0];
  if (!mapping) {
    throw new Error("还没有配置任何模型映射。");
  }

  return {
    source: mapping.localModelId,
    remoteModelId: mapping.remoteModelId,
    remoteBaseUrl: mapping.remoteBaseUrl,
    remoteApiKey: modelApiKey(mapping),
    remoteProtocol: mapping.remoteProtocol || "anthropic"
  };
}

function modelApiKey(mapping) {
  return Object.prototype.hasOwnProperty.call(mapping, "remoteApiKey") ? mapping.remoteApiKey || "" : "";
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  parseArgs,
  loadConfig,
  loadOptionalConfig,
  loadRuntimeConfig,
  normalizeConfig,
  publicConfig,
  resolveModel,
  resolveImageModel,
  saveSimpleConfig,
  saveWebConfig,
  writeStarterConfig
};
