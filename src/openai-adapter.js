"use strict";

// Translates between Anthropic Messages API and OpenAI Chat Completions API.
// References:
// - Anthropic Messages API: https://docs.anthropic.com/en/api/messages
// - OpenAI Chat Completions API: https://platform.openai.com/docs/api-reference/chat

// ---------------------------------------------------------------------------
// Request: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function anthropicContentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks = content.filter((b) => b.type === "text" || b.type === "image");
  if (blocks.length === 0) return null;
  if (blocks.every((b) => b.type === "text")) {
    return blocks.map((b) => b.text).join("");
  }

  return blocks
    .map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      const src = b.source;
      if (src.type === "base64") {
        return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
      }
      return { type: "image_url", image_url: { url: src.url } };
    })
    .filter(Boolean);
}

function anthropicMessagesToOpenAI(messages, systemPrompt) {
  const result = [];

  if (systemPrompt) {
    const systemText =
      typeof systemPrompt === "string"
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt.map((b) => b.text || "").join("\n")
          : "";
    if (systemText) result.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    const { role, content } = msg;

    if (role === "user") {
      if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === "tool_result");
        const otherBlocks = content.filter((b) => b.type !== "tool_result");

        for (const tr of toolResults) {
          const trText =
            typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.map((b) => b.text || "").join("")
                : "";
          result.push({ role: "tool", tool_call_id: tr.tool_use_id, content: trText });
        }

        if (otherBlocks.length > 0) {
          const oaiContent = anthropicContentToOpenAI(otherBlocks);
          if (oaiContent !== null) result.push({ role: "user", content: oaiContent });
        }
      } else {
        result.push({ role: "user", content: anthropicContentToOpenAI(content) });
      }
    } else if (role === "assistant") {
      if (Array.isArray(content)) {
        const textBlocks = content.filter((b) => b.type === "text");
        const toolUseBlocks = content.filter((b) => b.type === "tool_use");
        const msgObj = { role: "assistant", content: textBlocks.length > 0 ? textBlocks.map((b) => b.text).join("") : null };

        if (toolUseBlocks.length > 0) {
          msgObj.tool_calls = toolUseBlocks.map((tu) => ({
            id: tu.id,
            type: "function",
            function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) }
          }));
        }

        result.push(msgObj);
      } else {
        result.push({ role: "assistant", content: anthropicContentToOpenAI(content) });
      }
    }
  }

  return result;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  }));
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") return { type: "function", function: { name: toolChoice.name } };
  return "auto";
}

/**
 * Build an OpenAI Chat Completions request body from an Anthropic Messages request body.
 */
function anthropicToOpenAI(anthropicBody, remoteModelId) {
  const oai = {
    model: remoteModelId,
    messages: anthropicMessagesToOpenAI(anthropicBody.messages, anthropicBody.system)
  };

  if (anthropicBody.max_tokens != null) oai.max_tokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature != null) oai.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p != null) oai.top_p = anthropicBody.top_p;
  if (anthropicBody.stream != null) oai.stream = anthropicBody.stream;
  if (anthropicBody.stop_sequences != null) oai.stop = anthropicBody.stop_sequences;

  const tools = anthropicToolsToOpenAI(anthropicBody.tools);
  if (tools) oai.tools = tools;

  const toolChoice = anthropicToolChoiceToOpenAI(anthropicBody.tool_choice);
  if (toolChoice != null) oai.tool_choice = toolChoice;

  if (anthropicBody.stream) {
    oai.stream_options = { include_usage: true };
  }

  return oai;
}

// ---------------------------------------------------------------------------
// Response: OpenAI → Anthropic
// ---------------------------------------------------------------------------

function mapFinishReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/**
 * Convert a complete (non-streaming) OpenAI response body to Anthropic Messages response format.
 */
function openAIToAnthropic(openAIBody, localModelId) {
  const choice = openAIBody.choices?.[0];
  if (!choice) throw new Error("OpenAI 响应中没有 choices 字段。");

  const message = choice.message;
  const content = [];

  if (message.content) content.push({ type: "text", text: message.content });

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  return {
    id: openAIBody.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: localModelId,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openAIBody.usage?.prompt_tokens || 0,
      output_tokens: openAIBody.usage?.completion_tokens || 0
    }
  };
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

function writeSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Consume an OpenAI SSE stream and re-emit it as Anthropic SSE events.
 * Handles text deltas and tool-call deltas.
 */
async function pipeOpenAIStreamAsAnthropic(openAIStream, res, localModelId) {
  const msgId = `msg_${Date.now()}`;

  writeSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model: localModelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  writeSSE(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });

  writeSSE(res, "ping", { type: "ping" });

  let lineBuffer = "";
  let outputTokens = 0;
  let stopReason = "end_turn";

  // openAI tcIndex → { blockIdx, id, name, argumentsBuf }
  const toolBlocks = new Map();
  let nextBlockIdx = 1;

  for await (const chunk of openAIStream) {
    lineBuffer += Buffer.from(chunk).toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed.startsWith("data: ")) continue;
      const raw = trimmed.slice(6);
      if (raw === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      if (parsed.usage) {
        outputTokens = parsed.usage.completion_tokens || outputTokens;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};

      if (delta.content) {
        writeSSE(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content }
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIdx = tc.index ?? 0;

          if (!toolBlocks.has(tcIdx)) {
            const blockIdx = nextBlockIdx++;
            const entry = {
              blockIdx,
              id: tc.id || `toolu_${Date.now()}_${tcIdx}`,
              name: tc.function?.name || "",
              argumentsBuf: ""
            };
            toolBlocks.set(tcIdx, entry);
            writeSSE(res, "content_block_start", {
              type: "content_block_start",
              index: blockIdx,
              content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} }
            });
          }

          const entry = toolBlocks.get(tcIdx);
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) {
            entry.argumentsBuf += tc.function.arguments;
            writeSSE(res, "content_block_delta", {
              type: "content_block_delta",
              index: entry.blockIdx,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments }
            });
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
      }
    }
  }

  writeSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });

  for (const [, entry] of toolBlocks) {
    writeSSE(res, "content_block_stop", { type: "content_block_stop", index: entry.blockIdx });
  }

  writeSSE(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });

  writeSSE(res, "message_stop", { type: "message_stop" });
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  pipeOpenAIStreamAsAnthropic
};
