import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRuntimeConfigService,
  registerAgentRuntimeConfigIpc,
} from "../electron/services/agent-runtime-config-service.mjs";

function ok(value) {
  return { result: { ok: true, value } };
}

function cloned(value) {
  return JSON.parse(JSON.stringify(value));
}

function setPath(target, segments, value) {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = cloned(value);
}

function unsetPath(target, segments) {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) return;
    current = current[segment];
  }
  delete current[segments.at(-1)];
}

function fakeControlPlane({ credential = { configured: false, writable: true } } = {}) {
  const calls = [];
  const state = {
    credentials: { DEEPSEEK_API_KEY: { ...credential } },
    namespaces: {
      "agent-default-model": {
        revision: 0,
        value: { model: "deepseek-v4-flash", provider: "deepseek-official" },
      },
      "llm-deepseek": {
        revision: 0,
        value: {
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
        },
      },
      "llm-suzu-compatible": {
        revision: 0,
        value: { providers: {} },
      },
    },
  };
  const api = {
    settings: {
      async describe() {
        return ok({
          hasDocument: true,
          writable: true,
          namespaces: Object.entries(state.namespaces).map(([ns, value]) => ({
            ns,
            revision: value.revision,
            value: cloned(value.value),
            writable: true,
          })),
        });
      },
      async mutate(value) {
        calls.push({ type: "settings.mutate", value: cloned(value) });
        const namespace = state.namespaces[value.ns];
        assert.ok(namespace, `unexpected settings namespace ${value.ns}`);
        assert.equal(value.expectedRevision, namespace.revision);
        for (const operation of value.ops) {
          if (operation.op === "set") setPath(namespace.value, operation.path, operation.value);
          else if (operation.op === "unset") unsetPath(namespace.value, operation.path);
          else assert.fail(`unexpected mutation ${operation.op}`);
        }
        namespace.revision += 1;
        return ok({});
      },
    },
    credentials: {
      async describe({ refs }) {
        const credentials = Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true, ...(state.credentials[ref] || {}) }]));
        return ok({ credentials });
      },
      async set(value) {
        calls.push({ type: "credentials.set", value: cloned(value) });
        state.credentials[value.ref] = { configured: true, source: "file", writable: true };
        return ok({});
      },
    },
    llm: {
      async models() {
        return ok({ groups: [{ id: "deepseek-official", models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }], failures: [] });
      },
      async discoverModels(value) {
        calls.push({ type: "llm.discoverModels", value: cloned(value) });
        return ok({ models: [{ id: "gateway-chat" }, { id: "gateway-reasoner" }] });
      },
    },
  };
  return { api, calls, runtime: { controlPlane: async () => api }, state };
}

test("Agent Core config service uses the native DeepSeek setting, credential, and default-model planes", async () => {
  const fixture = fakeControlPlane();
  const service = createAgentRuntimeConfigService({ runtime: fixture.runtime });

  const before = await service.runtimeSnapshot();
  assert.equal(before.runtime, "agent-core");
  assert.equal(before.status, "new");
  assert.equal(before.providerId, "deepseek");
  assert.equal(before.hasApiKey, false);
  assert.equal(before.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(before.models, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(before.providerChoices.map((item) => item.id), ["deepseek", "minimax", "bailian-coding", "bailian-payg", "kimi", "custom"]);

  const saved = await service.saveModelConfiguration({
    apiKey: "local-test-key",
    baseUrl: "https://gateway.example.test/v1",
    model: "deepseek-v4-pro",
    provider: "deepseek",
  });
  assert.equal(saved.status, "ready");
  assert.equal(saved.apiKeySource, "file");
  assert.equal(saved.baseUrl, "https://gateway.example.test/v1");
  assert.equal(saved.model, "deepseek-v4-pro");
  assert.deepEqual(fixture.calls, [
    {
      type: "settings.mutate",
      value: {
        ns: "llm-deepseek",
        expectedRevision: 0,
        ops: [{ op: "set", path: ["baseURL"], value: "https://gateway.example.test/v1" }],
      },
    },
    { type: "credentials.set", value: { ref: "DEEPSEEK_API_KEY", value: "local-test-key" } },
    {
      type: "settings.mutate",
      value: {
        ns: "agent-default-model",
        expectedRevision: 0,
        ops: [
          { op: "set", path: ["provider"], value: "deepseek-official" },
          { op: "set", path: ["model"], value: "deepseek-v4-pro" },
          { op: "unset", path: ["reasoningEffort"] },
        ],
      },
    },
  ]);
  assert.deepEqual((await service.fetchModels()).models, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("Agent Core config service writes a custom compatible provider through Suzu's compatible endpoint layer", async () => {
  const fixture = fakeControlPlane();
  const service = createAgentRuntimeConfigService({ runtime: fixture.runtime });

  const saved = await service.saveModelConfiguration({
    apiKey: "gateway-secret",
    baseUrl: "https://gateway.example.test/v1",
    model: "gateway-chat",
    protocol: "openai-completions",
    provider: "custom",
  });
  assert.equal(saved.status, "ready");
  assert.equal(saved.providerId, "custom");
  assert.equal(saved.providerRoute, "suzu-custom");
  assert.equal(saved.protocol, "openai-completions");
  assert.equal(saved.model, "gateway-chat");
  assert.equal(saved.baseUrl, "https://gateway.example.test/v1");

  const profileMutation = fixture.calls.find((call) => call.type === "settings.mutate" && call.value.ns === "llm-suzu-compatible");
  assert.deepEqual(profileMutation?.value, {
    ns: "llm-suzu-compatible",
    expectedRevision: 0,
    ops: [{
      op: "set",
      path: ["providers", "suzu-custom"],
      value: {
        displayName: "自定义兼容服务",
        apiKeyEnv: "SUZU_AGENT_SUZU_CUSTOM_API_KEY",
        api: "openai-completions",
        baseURL: "https://gateway.example.test/v1",
        models: [{
          id: "gateway-chat",
          name: "gateway-chat",
          contextWindow: 262144,
          maxTokens: 32768,
        }],
      },
    }],
  });
  assert.ok(fixture.calls.some((call) => call.type === "credentials.set" && call.value.ref === "SUZU_AGENT_SUZU_CUSTOM_API_KEY"));
  assert.ok(fixture.calls.some((call) => call.type === "settings.mutate" && call.value.ns === "agent-default-model" && call.value.ops[0].value === "suzu-custom"));

  const discovered = await service.fetchModels({
    apiKey: "gateway-secret",
    baseUrl: "https://gateway.example.test/v1",
    model: "gateway-chat",
    protocol: "openai-completions",
    provider: "custom",
  });
  assert.deepEqual(discovered.models, ["gateway-chat", "gateway-reasoner"]);
  assert.ok(fixture.calls.some((call) => call.type === "llm.discoverModels" && call.value.provider === "suzu-custom"));
});

test("Agent Core config service refuses a first save without a credential and forwards model-fetch input through IPC", async () => {
  const fixture = fakeControlPlane();
  const service = createAgentRuntimeConfigService({ runtime: fixture.runtime });
  await assert.rejects(
    service.saveModelConfiguration({ baseUrl: "https://api.deepseek.com" }),
    (error) => error?.code === "AGENT_API_KEY_REQUIRED",
  );

  const handlers = new Map();
  registerAgentRuntimeConfigIpc({
    agentRuntimeConfigService: service,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  assert.equal(typeof handlers.get("agent-runtime:snapshot"), "function");
  assert.equal(typeof handlers.get("agent-runtime:save-model-configuration"), "function");
  assert.equal(typeof handlers.get("agent-runtime:fetch-models"), "function");
  await handlers.get("agent-runtime:fetch-models")(null, {
    baseUrl: "https://gateway.example.test/v1",
    model: "x",
    protocol: "openai-completions",
    provider: "custom",
  });
  assert.ok(fixture.calls.some((call) => call.type === "llm.discoverModels"));
});
