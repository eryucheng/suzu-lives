import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CapabilityRegistryError,
  configureCapability,
  createCapabilitySnapshot,
  getCapabilityDefinition,
  invokeCapability,
  invokeCapabilityPlan,
  issueCapabilityInvocationAuthorization,
  setCapabilityEnabled,
} from "../src/index.mjs";
import { CapabilityExecutionError } from "@suzu-lives/capability-runtime";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("catalog reports partial executor migration, actual static configuration, runtime authorization, and registration separately", () => {
  const root = temporaryDirectory("suzu-registry-catalog-");
  const snapshot = createCapabilitySnapshot({ dataRoot: root, projectRoot: "C:/example/project", launcher: { command: "suzu-lives", available: true } });
  const vision = snapshot.find((item) => item.id === "image-vision");
  const camera = snapshot.find((item) => item.id === "computer-camera");
  const phone = snapshot.find((item) => item.id === "phone-camera");

  assert.equal(camera.migration.state, "partial-executor");
  assert.match(camera.migration.label, /部分接入/u);
  assert.equal(vision.configuration.state, "not-configured");
  assert.match(vision.enableReason, /安全模型凭据/u);
  assert.equal(vision.registration.canRegister, true);
  assert.equal(phone.migration.state, "deferred");
  assert.equal(phone.registration.supported, false);
});

test("configuration is a per-ability whitelist and registry.json retains no unknown or credential fields", () => {
  const root = temporaryDirectory("suzu-registry-config-");
  assert.throws(
    () => configureCapability({ dataRoot: root, id: "computer-camera", configuration: { pythonCommand: "python", extra: "no" } }),
    CapabilityRegistryError,
  );
  assert.throws(
    () => configureCapability({ dataRoot: root, id: "image-vision", configuration: { provider: { baseUrl: "https://vision.example.test/v1", model: "vision-test", apiKeyEnv: "SHOULD_NOT_BE_STORED" } } }),
    CapabilityRegistryError,
  );
  assert.throws(
    () => configureCapability({ dataRoot: root, id: "web-browser", configuration: { executablePath: "C:/configured/chrome.exe", access_token: "never" } }),
    CapabilityRegistryError,
  );
  const state = configureCapability({ dataRoot: root, id: "computer-camera", configuration: { pythonCommand: "python" } });
  assert.equal(state.enabled, false);
  const registry = JSON.parse(fs.readFileSync(path.join(root, "capabilities", "registry.json"), "utf8"));
  assert.deepEqual(registry.abilities["computer-camera"].configuration, { pythonCommand: "python" });
  assert.equal(JSON.stringify(registry).match(/token|key|secret|password/iu), null);
});

test("plans stay non-executing, while invoke rejects disabled and bare authorize requests", async () => {
  const root = temporaryDirectory("suzu-registry-gate-");
  const plan = invokeCapabilityPlan({ id: "site-automation", dataRoot: root, request: { siteId: "douyin", action: "status" } });
  assert.equal(plan.willOperateSite, false);
  assert.equal(plan.willAttachBrowser, false);
  configureCapability({ dataRoot: root, id: "computer-camera", configuration: { pythonCommand: "python" } });
  await assert.rejects(
    () => invokeCapability({ id: "computer-camera", dataRoot: root, request: { operation: "start", cameraIndex: 0 } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_DISABLED",
  );
  setCapabilityEnabled({ id: "computer-camera", dataRoot: root, enabled: true });
  await assert.rejects(
    () => invokeCapability({ id: "computer-camera", dataRoot: root, request: { operation: "start", cameraIndex: 0 } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_CREDENTIAL_REQUIRED",
  );
  await assert.rejects(
    () => invokeCapability({ id: "computer-camera", dataRoot: root, request: { operation: "start", cameraIndex: 0, authorize: true } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_CREDENTIAL_REQUIRED",
  );
});

test("registry issues intent-bound credentials and only invokes a camera lifecycle through fake adapters", async () => {
  const root = temporaryDirectory("suzu-registry-invoke-");
  configureCapability({ dataRoot: root, id: "computer-camera", configuration: { pythonCommand: "python" } });
  setCapabilityEnabled({ dataRoot: root, id: "computer-camera", enabled: true });
  const fakeSession = {
    capture: async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "fixture-image", "utf8");
      return { status: "captured", outputPath };
    },
    close: async () => ({ status: "closed", simulated: true }),
  };
  const adapters = { computerCamera: { dependencyProbe: async () => true, sessionFactory: async () => fakeSession, randomId: () => "fixture-session" } };
  const startRequest = { operation: "start", cameraIndex: 2, warmupSeconds: 0.1 };
  const startAuthorization = issueCapabilityInvocationAuthorization({ id: "computer-camera", dataRoot: root, request: startRequest });
  const started = await invokeCapability({ id: "computer-camera", dataRoot: root, request: startRequest, authorizationCredential: startAuthorization.credential, adapters });
  assert.equal(started.status, "ready");

  const captureRequest = { operation: "capture", cameraIndex: 2 };
  const captureAuthorization = issueCapabilityInvocationAuthorization({ id: "computer-camera", dataRoot: root, request: captureRequest });
  const captured = await invokeCapability({ id: "computer-camera", dataRoot: root, request: captureRequest, authorizationCredential: captureAuthorization.credential, adapters });
  assert.equal(captured.status, "ok");
  assert.equal(fs.existsSync(captured.outputPath), true);

  await assert.rejects(
    () => invokeCapability({ id: "computer-camera", dataRoot: root, request: { operation: "capture", cameraIndex: 2 }, authorizationCredential: captureAuthorization.credential, adapters }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_REPLAYED",
  );
  const closeRequest = { operation: "close", cameraIndex: 2 };
  const closeAuthorization = issueCapabilityInvocationAuthorization({ id: "computer-camera", dataRoot: root, request: closeRequest });
  const closed = await invokeCapability({ id: "computer-camera", dataRoot: root, request: closeRequest, authorizationCredential: closeAuthorization.credential, adapters });
  assert.equal(closed.status, "closed");
  assert.equal(closed.userConfirmedClose, true);
});

test("unsafe protocol gaps remain disabled even when their non-secret fields are stored", () => {
  const root = temporaryDirectory("suzu-registry-protocol-gap-");
  configureCapability({ dataRoot: root, id: "image-vision", configuration: { provider: { baseUrl: "https://vision.example.test/v1", model: "vision-test" } } });
  assert.throws(() => setCapabilityEnabled({ dataRoot: root, id: "image-vision", enabled: true }), CapabilityRegistryError);
  configureCapability({ dataRoot: root, id: "iphone-bridge", configuration: {} });
  assert.throws(() => setCapabilityEnabled({ dataRoot: root, id: "iphone-bridge", enabled: true }), CapabilityRegistryError);
  assert.equal(getCapabilityDefinition("VOICE-MESSAGE").id, "voice-message");
});
