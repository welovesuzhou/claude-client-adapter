# llm-model-forward

本地大模型 API 转发器。客户端连本机，真实请求按配置转发到远程模型服务。

支持两种后端协议：

```text
Claude / Anthropic 客户端 → http://127.0.0.1:18787/anthropic → 远程 Anthropic 兼容服务
Claude / Anthropic 客户端 → http://127.0.0.1:18787/anthropic → 本地网关（协议转换）→ 远程 OpenAI 兼容服务
任意 OpenAI 客户端       → http://127.0.0.1:18787/openai/v1/images/generations → 远程图片生成服务
```

![配置页面截图](docs/image.png)

## 安装

### AI Agent 安装（推荐）

普通用户可以把当前项目链接直接发送给 Codex / Claude / OpenClaw 等 Agent 工具安装。

```text
帮我安装这个项目，使用PM2运行 https://github.com/jzj1993/llm-model-forward
```

### 手动安装

```bash
git clone git@github.com:jzj1993/llm-model-forward.git
cd llm-model-forward
npm install
```

## 运行

### 临时运行

```bash
npm start
```

临时运行适合临时使用或测试。关闭终端后服务会停止。

### PM2 持续运行（推荐）

安装 PM2：

```bash
npm install -g pm2
```

后台启动：

```bash
pm2 start ecosystem.config.cjs
```

常用命令：

```bash
pm2 status llm-model-forward
pm2 logs llm-model-forward
pm2 restart llm-model-forward
pm2 stop llm-model-forward
pm2 delete llm-model-forward
```

开机自启：

```bash
pm2 save
pm2 startup
```

`pm2 startup` 会输出一条需要复制执行的命令，照着执行一次即可。

**注意：直接编辑 `config.json` 后需要执行 `pm2 restart llm-model-forward` 才能生效。**

## 本工具配置

### 网页后台配置（推荐）

**普通用户建议只用网页改配置。**

<http://127.0.0.1:18787>

在网页中点"新增"按钮，按网页中的提示设置即可。其中：

- 远程模型参数，填写真实的大模型信息，例如 DeepSeek
- 本地模型名可以任意填写，对于 Claude Desktop / Cowork App 场景，需要填 `claude` 开头的名字。
- 如果有多个不同的大模型提供商、模型，可以都填上。

### 配置文件

配置文件：项目目录下的 `config.json`，不存在会自动创建。

格式：

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 18787
  },
  "debug": false,
  "models": [
    {
      "localModelId": "claude-opus-4-5",
      "remoteModelId": "your-anthropic-compatible-model",
      "remoteBaseUrl": "https://provider-a.example.com/anthropic",
      "remoteApiKey": "your-api-key",
      "enabled": true
    },
    {
      "localModelId": "claude-opus-4-7",
      "remoteModelId": "gpt-5.5",
      "remoteBaseUrl": "https://openai-compatible-provider.example.com",
      "remoteApiKey": "your-openai-api-key",
      "remoteProtocol": "openai",
      "enabled": true
    }
  ],
  "imageModels": [
    {
      "id": "gpt-image-1",
      "remoteModelId": "gpt-image-1",
      "remoteBaseUrl": "https://openai-compatible-provider.example.com",
      "remoteApiKey": "your-openai-api-key",
      "enabled": true
    }
  ]
}
```

**`remoteProtocol` 字段说明：**

| 值 | 说明 |
|---|---|
| 不填（默认） | Anthropic 协议透传，适合 DeepSeek 等 Anthropic 兼容服务 |
| `"openai"` | 自动将 Anthropic 请求转换为 OpenAI Chat Completions 格式，适合 GPT 等服务 |

## Claude / Agent 客户端配置

Base URL：

```text
http://127.0.0.1:18787/anthropic
```

客户端密钥（API Key）可以随便填，例如：

```text
local-anything
```

真正发给远程模型的密钥（API Key）来自配置文件；没填时，不会向远程模型发送密钥。

模型名称 / Model ID：使用前面配置的 `localModelId`。

## 图片生成接口（OpenAI 格式）

网关同时暴露 OpenAI 兼容的图片生成端点，供任意 OpenAI 客户端调用：

```bash
POST http://127.0.0.1:18787/openai/v1/images/generations
Authorization: Bearer local-anything
Content-Type: application/json

{
  "model": "gpt-image-1",
  "prompt": "a red cat",
  "n": 1,
  "size": "1024x1024"
}
```

查看已配置的图片模型：

```bash
GET http://127.0.0.1:18787/openai/v1/models
```

## 安全性说明

本项目所有的 API Key 都保存在本地。只会发送给用户配置的大模型接口，不会往任何第三方网站发送。

转发接口时，只有当原始接口中包含了 API Key 字段，才会把 API Key 发给远程大模型接口，避免 API Key 泄露给不相关的接口。

`config.json` 已加入 `.gitignore`，不会被 git 提交。

## 开发相关

### 实现思路

- Node.js + Express 提供本地服务，EJS + Tailwind 提供配置页面。
- `/anthropic/*` 去掉前缀后，按顶层 `model` 字段选择模型路由：
  - 若路由的 `remoteProtocol` 为 `openai`，自动将 Anthropic Messages 格式转换为 OpenAI Chat Completions 格式后转发，响应再转换回 Anthropic 格式（含流式 SSE、工具调用、视觉）。
  - 否则直接透传给 Anthropic 兼容服务。
- 嵌套结构中出现跨后端 `model` 引用时，自动归并到主路由的模型 ID，不报错。
- `/openai/v1/images/generations` 代理图片生成请求，替换 API Key 后直接转发。
- 如果客户端带了 `x-api-key` 或 `Authorization`，转发时会替换成 `remoteApiKey`；客户端没带鉴权头时不会主动添加。

### 测试

```bash
npm test
```

### 健康检查

```bash
curl http://127.0.0.1:18787/health
```

返回示例：

```json
{
  "ok": true,
  "configured": true,
  "models": ["claude-opus-4-5", "claude-opus-4-7"],
  "imageModels": ["gpt-image-1", "gpt-image-2"]
}
```

### 调试日志

默认不写调试日志。需要排查转发失败时，修改 `config.json`：

```json
{
  "debug": true
}
```

重启服务：

```bash
pm2 restart llm-model-forward
```

查看日志：

```bash
tail -f data/llm-model-forward.log
```

日志会记录转发方法、远程模型 URL、远程模型状态码和错误信息；密钥会被隐藏。`data/` 已被 Git 忽略。
