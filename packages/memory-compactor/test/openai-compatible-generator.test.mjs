import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiCompatibleStructuredGenerator } from "../src/index.mjs";

function response(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || "" },
    json: async () => payload,
  };
}

test("OpenAI-compatible generator requests JSON and returns the shared generator envelope", async () => {
  let request = null;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      name: "DeepSeek",
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "deepseek-chat",
      apiKey: "secret",
    },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        id: "request-1",
        model: "deepseek-chat",
        choices: [{ message: { content: "```json\n{\"analyses\":[]}\n```" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      });
    },
  });
  const result = await generate({
    input: "evidence",
    systemPrompt: "analyze",
    schemaName: "memory-goal-v1",
    schema: { type: "object", required: ["analyses"] },
  });
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.match(request.body.messages[0].content, /JSON Schema/u);
  assert.deepEqual(result.output, { analyses: [] });
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4 });
  assert.equal(result.model, "deepseek-chat");
  assert.equal(result.requestId, "request-1");
  assert.equal(result.metadata.provider, "DeepSeek");
});

test("DashScope saved base URL uses its OpenAI-compatible text endpoint", async () => {
  let requestedUrl = "";
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      type: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "fixture-qwen",
      key: "secret",
    },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response({ choices: [{ message: { content: "{\"analyses\":[]}" } }] });
    },
  });
  await generate({ input: "evidence", systemPrompt: "analyze" });
  assert.equal(requestedUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("configured provider errors do not expose credentials and invalid JSON is rejected", async () => {
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "do-not-leak",
    },
    fetchImpl: async () => response({ error: { message: "provider unavailable" } }, { status: 503 }),
  });
  await assert.rejects(
    () => generate({ input: "evidence", systemPrompt: "analyze" }),
    (error) => /503.*provider unavailable/u.test(error.message) && !error.message.includes("do-not-leak"),
  );

  const invalid = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "secret",
    },
    fetchImpl: async () => response({ choices: [{ message: { content: "not-json" } }] }),
  });
  await assert.rejects(
    () => invalid({ input: "evidence", systemPrompt: "analyze" }),
    /不是有效 JSON/u,
  );
});
