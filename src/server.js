#!/usr/bin/env node
"use strict";

// References:
// - Anthropic API overview: https://platform.claude.com/docs/en/api/overview
// - UI layout inspiration: https://github.com/Xiaoming-Team/flux-gate

const express = require("express");
const http = require("node:http");
const path = require("node:path");
const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadOptionalConfig,
  parseArgs,
  publicConfig,
  resolveModel,
  resolveImageModel,
  saveWebConfig
} = require("./config");
const { forwardAnthropicRequest, forwardImageRequest } = require("./forwarder");
const { createLogger } = require("./logger");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const state = await createConfigState(args.configPath);
  const server = createServer(state);
  const listen = state.getConfig()?.listen || { host: DEFAULT_HOST, port: DEFAULT_PORT };

  server.on("error", (error) => {
    console.error(`服务启动失败：${error.message}`);
    process.exit(1);
  });

  server.listen(listen.port, listen.host, () => {
    const address = server.address();
    const host = typeof address === "object" && address ? address.address : listen.host;
    const port = typeof address === "object" && address ? address.port : listen.port;
    console.log(`llm-model-forward 已启动：http://${host}:${port}`);
    console.log(`配置文件：${state.configPath}`);
    if (state.getError()) {
      console.log(`配置页面：http://${host}:${port}/`);
      console.log(`配置状态：${state.getError().message}`);
    }
  });
}

async function createConfigState(configPath) {
  const loaded = await loadOptionalConfig(configPath);
  let currentConfig = loaded.config;
  let currentError = loaded.error;

  return {
    configPath: loaded.configPath,
    getConfig() {
      return currentConfig;
    },
    getError() {
      return currentError;
    },
    getLogger() {
      return createLogger({ debug: currentConfig?.debug });
    },
    async save(input) {
      currentConfig = await saveWebConfig(loaded.configPath, input, currentConfig);
      currentError = null;
      return currentConfig;
    }
  };
}

function createServer(configOrState) {
  const state = toConfigState(configOrState);
  const app = createApp(state);
  return http.createServer(app);
}

function createApp(state) {
  const app = express();
  app.set("views", path.join(__dirname, "..", "views"));
  app.set("view engine", "ejs");

  app.get("/", (req, res) => {
    res.render("admin");
  });

  app.get("/api/config", localOnly, (req, res) => {
    res.json(publicConfig(state.getConfig(), state.configPath, state.getError()));
  });

  app.post("/api/config", localOnly, express.json({ limit: "1mb" }), async (req, res, next) => {
    try {
      const saved = await state.save(req.body || {});
      await getLogger(state).debug("配置已保存", {
        modelCount: saved.models.length,
        enabledModelCount: saved.models.filter((model) => model.enabled !== false).length
      });
      res.json({ ok: true, config: publicConfig(saved, state.configPath, null) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (req, res) => {
    const config = state.getConfig();
    res.json({
      ok: true,
      configured: Boolean(config),
      models: config?.models?.filter((m) => m.enabled !== false).map((m) => m.localModelId) || [],
      imageModels: config?.imageModels?.map((m) => m.id) || []
    });
  });

  // OpenAI-compatible image generation endpoint
  // POST /openai/v1/images/generations
  app.post("/openai/v1/images/generations", express.json({ limit: "10mb" }), async (req, res, next) => {
    const config = state.getConfig();
    if (!config) {
      res.status(503).json({ error: { type: "not_configured_error", message: "llm-model-forward 还没有完成配置。" } });
      return;
    }

    try {
      const body = req.body || {};
      const imageRoute = resolveImageModel(config, body.model);
      await forwardImageRequest(req, res, imageRoute, body, getLogger(state));
    } catch (error) {
      next(error);
    }
  });

  // List available image models
  app.get("/openai/v1/models", (req, res) => {
    const config = state.getConfig();
    const imageModels = (config?.imageModels || []).map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "openai"
    }));
    res.json({ object: "list", data: imageModels });
  });

  app.all(/^\/anthropic(\/.*)?$/, async (req, res, next) => {
    const config = state.getConfig();
    if (!config) {
      res.status(503).json({
        type: "error",
        error: {
          type: "not_configured_error",
          message: "llm-model-forward 还没有完成配置。请打开首页填写并保存配置。"
        }
      });
      return;
    }

    try {
      const remotePath = stripAnthropicPrefix(req.originalUrl || req.url || req.path);
      await forwardAnthropicRequest(req, res, config, remotePath, resolveModel, getLogger(state));
    } catch (error) {
      await getLogger(state).debug("转发失败", {
        method: req.method,
        path: req.originalUrl || req.url || req.path,
        error: error.message,
        statusCode: error.statusCode || 502
      });
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      type: "error",
      error: {
        type: "not_found_error",
        message: `没有找到接口：${req.method} ${req.path}`
      }
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      console.error(`转发过程中出错：${error.message}`);
      res.destroy(error);
      return;
    }

    res.status(error.statusCode || 502).json({
      type: "error",
      error: {
        type: "api_error",
        message: error.message
      }
    });
  });

  return app;
}

function stripAnthropicPrefix(url) {
  const withoutPrefix = url.replace(/^\/anthropic(?=\/|$)/, "");
  return withoutPrefix || "/";
}

function toConfigState(configOrState) {
  if (configOrState && typeof configOrState.getConfig === "function") {
    return configOrState;
  }

  return {
    configPath: configOrState?.configPath,
    getConfig() {
      return configOrState;
    },
    getError() {
      return null;
    },
    getLogger() {
      return createLogger({ debug: configOrState?.debug });
    },
    async save() {
      throw Object.assign(new Error("这个服务使用的是只读配置，不能通过网页保存。"), { statusCode: 405 });
    }
  };
}

function getLogger(state) {
  return typeof state.getLogger === "function" ? state.getLogger() : createLogger({ debug: state.getConfig()?.debug });
}

function localOnly(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ ok: false, error: "配置接口只允许本机访问。" });
    return;
  }
  next();
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function printHelp() {
  console.log(`用法：llm-model-forward --config config.json

选项：
  -c, --config <path>  指定 JSON 配置文件路径，默认使用 ./config.json。
  -h, --help           显示帮助信息。
`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  createServer,
  createConfigState,
  stripAnthropicPrefix
};
