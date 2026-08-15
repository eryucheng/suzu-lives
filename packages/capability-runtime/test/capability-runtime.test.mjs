import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CapabilityExecutionError,
  assertInvocationGate,
  assertVerifiedCapabilityAuthorization,
  consumeCapabilityAuthorization,
  issueCapabilityAuthorization,
} from "../src/index.mjs";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("executor gate rejects disabled, unconfigured, and missing dependencies before an executor can run", () => {
  assert.throws(
    () => assertInvocationGate({ abilityId: "example", gate: { enabled: false, configured: true }, dependencies: { adapter: true } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_DISABLED",
  );
  assert.throws(
    () => assertInvocationGate({ abilityId: "example", gate: { enabled: true, configured: false }, dependencies: { adapter: true } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "CAPABILITY_NOT_CONFIGURED",
  );
  assert.throws(
    () => assertInvocationGate({ abilityId: "example", gate: { enabled: true, configured: true }, dependencies: { adapter: false } }),
    (error) => error instanceof CapabilityExecutionError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
});

test("software-issued credential is short-lived, opaque to its raw scope, and accepted once for the exact intent", () => {
  const root = temporaryDirectory("suzu-capability-auth-");
  const scope = { cameraIndex: 2, operation: "capture", userSelectionDigest: "not-a-real-path" };
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId: "computer-camera", action: "capture", scope, ttlMs: 30_000, now: () => 1_000 });
  assert.match(issued.credential, /^suzu-capability-v1\./u);
  assert.doesNotMatch(issued.credential, /userSelectionDigest|not-a-real-path/u);

  const authorization = consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action: "capture", scope, now: () => 2_000 });
  assert.equal(assertVerifiedCapabilityAuthorization({ authorization, abilityId: "computer-camera", action: "capture", scope }), true);
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action: "capture", scope, now: () => 2_001 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_REPLAYED",
  );
});

test("credential verification rejects forged, expired, replayed, and intent-mismatched invocations", () => {
  const root = temporaryDirectory("suzu-capability-auth-reject-");
  const scope = { cameraIndex: 2, operation: "capture", optionsDigest: "fixture" };
  const issued = issueCapabilityAuthorization({ dataRoot: root, abilityId: "computer-camera", action: "capture", scope, ttlMs: 10, now: () => 100 });
  const forged = issued.credential.replace(/.$/u, (last) => last === "A" ? "B" : "A");
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: forged, abilityId: "computer-camera", action: "capture", scope, now: () => 101 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_FORGED",
  );
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action: "observe", scope, now: () => 101 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_MISMATCH",
  );
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "image-generation", action: "capture", scope, now: () => 101 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_MISMATCH",
  );
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action: "capture", scope: { ...scope, optionsDigest: "different" }, now: () => 101 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_MISMATCH",
  );
  assert.throws(
    () => consumeCapabilityAuthorization({ dataRoot: root, credential: issued.credential, abilityId: "computer-camera", action: "capture", scope, now: () => 110 }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_EXPIRED",
  );
  assert.throws(
    () => assertVerifiedCapabilityAuthorization({ authorization: { abilityId: "computer-camera" }, abilityId: "computer-camera", action: "capture", scope }),
    (error) => error instanceof CapabilityExecutionError && error.code === "AUTHORIZATION_CREDENTIAL_REQUIRED",
  );
});
