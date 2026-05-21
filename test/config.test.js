"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PORT,
  loadOptionalConfig,
  normalizeConfig,
  publicConfig,
  parseArgs,
  resolveModel,
  saveSimpleConfig,
  saveWebConfig
} = require("../src/config");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("parseArgs supports config path forms", () => {
  assert.equal(parseArgs(["--config", "a.json"]).configPath, "a.json");
  assert.equal(parseArgs(["-c", "b.json"]).configPath, "b.json");
  assert.equal(parseArgs(["--config=c.json"]).configPath, "c.json");
});

test("saveSimpleConfig writes beginner-friendly JSON config", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-model-forward-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = await saveSimpleConfig(configPath, {
    host: "127.0.0.1",
    port: 3000,
    remoteBaseUrl: "https://example.com",
    remoteApiKey: "key",
    remoteModelId: "provider-default"
  });

  assert.equal(resolveModel(config, "any-claude-model").remoteModelId, "provider-default");
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), {
    listen: {
      host: "127.0.0.1",
      port: 3000
    },
    debug: false,
    models: [
      {
        localModelId: "claude",
        remoteModelId: "provider-default",
        remoteBaseUrl: "https://example.com",
        remoteApiKey: "key",
        enabled: true
      }
    ]
  });
});

test("loadOptionalConfig creates starter config when missing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-model-forward-missing-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const loaded = await loadOptionalConfig(configPath);
  const starter = JSON.parse(await fs.readFile(configPath, "utf8"));

  assert.equal(loaded.config, null);
  assert.equal(loaded.configPath, configPath);
  assert.match(loaded.error.message, /已自动创建/);
  assert.equal(starter.listen.port, DEFAULT_PORT);
  assert.equal(starter.debug, false);
  assert.deepEqual(starter.models, []);
});

test("saveWebConfig writes multiple model routes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-model-forward-multi-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = await saveWebConfig(configPath, {
    models: [
      {
        localModelId: "claude-sonnet",
        remoteBaseUrl: "https://sonnet.example.com",
        remoteApiKey: "sonnet-key",
        remoteModelId: "provider-sonnet"
      },
      {
        localModelId: "claude-haiku",
        remoteBaseUrl: "https://haiku.example.com",
        remoteApiKey: "haiku-key",
        remoteModelId: "provider-haiku"
      }
    ]
  });

  assert.deepEqual(resolveModel(config, "claude-sonnet"), {
    source: "claude-sonnet",
    remoteModelId: "provider-sonnet",
    remoteBaseUrl: "https://sonnet.example.com",
    remoteApiKey: "sonnet-key",
    remoteProtocol: "anthropic"
  });
  assert.deepEqual(resolveModel(config, "claude-haiku"), {
    source: "claude-haiku",
    remoteModelId: "provider-haiku",
    remoteBaseUrl: "https://haiku.example.com",
    remoteApiKey: "haiku-key",
    remoteProtocol: "anthropic"
  });
});

test("saveWebConfig preserves debug switch", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-model-forward-debug-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = await saveWebConfig(
    configPath,
    {
      models: [
        {
          localModelId: "claude-sonnet",
          remoteBaseUrl: "https://sonnet.example.com",
          remoteApiKey: "",
          remoteModelId: "provider-sonnet"
        }
      ]
    },
    normalizeConfig(
      {
        debug: true,
        models: [
          {
            localModelId: "old",
            remoteModelId: "old-remoteModelId",
            remoteBaseUrl: "https://old.example.com"
          }
        ]
      },
      configPath
    )
  );

  assert.equal(config.debug, true);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).debug, true);
});

test("saveWebConfig allows deleting the last model", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-model-forward-empty-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const config = await saveWebConfig(
    configPath,
    {
      models: []
    },
    normalizeConfig(
      {
        models: [
          {
            localModelId: "claude",
            remoteModelId: "remote",
            remoteBaseUrl: "https://example.com",
            remoteApiKey: "key"
          }
        ]
      },
      configPath
    )
  );

  assert.equal(config.models.length, 0);
  assert.equal(publicConfig(config, configPath, null).configured, false);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")).models, []);
});

test("resolveModel errors clearly with no models", () => {
  const config = normalizeConfig(
    {
      models: []
    },
    "/tmp/config.json"
  );

  assert.throws(() => resolveModel(config, "claude"), /还没有配置任何模型映射/);
});

test("empty model API key stays empty instead of falling back", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "no-key-model",
          remoteModelId: "remote",
          remoteBaseUrl: "https://example.com",
          remoteApiKey: ""
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.equal(resolveModel(config, "no-key-model").remoteApiKey, "");
  assert.equal(publicConfig(config, "/tmp/config.json", null).models[0].remoteApiKey, "");
});

test("normalizeConfig allows model without API key", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "public-model",
          remoteModelId: "remote",
          remoteBaseUrl: "https://example.com"
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.equal(resolveModel(config, "public-model").remoteApiKey, "");
});

test("publicConfig exposes API keys for local inline editing", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "claude-sonnet",
          remoteModelId: "fallback",
          remoteBaseUrl: "https://example.com",
          remoteApiKey: "secret"
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.deepEqual(publicConfig(config, "/tmp/config.json", null), {
    configured: true,
    configPath: "/tmp/config.json",
    error: null,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    localBaseUrl: `http://127.0.0.1:${DEFAULT_PORT}`,
    models: [
      {
        localModelId: "claude-sonnet",
        remoteBaseUrl: "https://example.com",
        remoteModelId: "fallback",
        remoteApiKey: "secret",
        hasApiKey: true,
        enabled: true
      }
    ]
  });
});

test("resolveModel maps exact model names", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "claude-3-5-sonnet-20241022",
          remoteModelId: "provider-sonnet",
          remoteBaseUrl: "https://example.com/",
          remoteApiKey: "key"
        },
        {
          localModelId: "claude-haiku",
          remoteModelId: "provider-default",
          remoteBaseUrl: "https://example.com/",
          remoteApiKey: "key"
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.deepEqual(resolveModel(config, "claude-3-5-sonnet-20241022"), {
    source: "claude-3-5-sonnet-20241022",
    remoteModelId: "provider-sonnet",
    remoteBaseUrl: "https://example.com",
    remoteApiKey: "key",
    remoteProtocol: "anthropic"
  });
});

test("resolveModel falls back to first model", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "claude-first",
          remoteModelId: "fallback",
          remoteBaseUrl: "https://example.com",
          remoteApiKey: "key"
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.equal(resolveModel(config, "unknown").remoteModelId, "fallback");
});

test("resolveModel ignores disabled models", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "disabled-model",
          remoteModelId: "disabled-remoteModelId",
          remoteBaseUrl: "https://example.com",
          remoteApiKey: "key",
          enabled: false
        },
        {
          localModelId: "enabled-model",
          remoteModelId: "enabled-remoteModelId",
          remoteBaseUrl: "https://example.com",
          remoteApiKey: "key"
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.equal(resolveModel(config, "disabled-model").remoteModelId, "enabled-remoteModelId");
  assert.equal(resolveModel(config, "unknown").remoteModelId, "enabled-remoteModelId");
});

test("resolveModel errors when all models are disabled", () => {
  const config = normalizeConfig(
    {
      models: [
        {
          localModelId: "disabled-model",
          remoteModelId: "disabled-remoteModelId",
          remoteBaseUrl: "https://example.com",
          enabled: false
        }
      ]
    },
    "/tmp/config.json"
  );

  assert.throws(() => resolveModel(config, "disabled-model"), /还没有配置任何模型映射/);
});
