import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  generateReleaseSigningKeyPair,
  signReleaseArtifact,
  verifyReleaseArtifact,
} from "../../../scripts/release-signing.mjs";

test("签发并验证 Ed25519 发布包签名", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-lives-release-signing-"));
  const artifactPath = path.join(temporaryRoot, "Suzu-Lives-Console-test-win-x64.zip");
  const privateKeyPath = path.join(temporaryRoot, "private", "eryuchengye.ed25519.private.pem");
  const publicKeyPath = path.join(temporaryRoot, "public", "eryuchengye.ed25519.pub");
  const signaturePath = `${artifactPath}.sig`;
  try {
    await fs.writeFile(artifactPath, "official release", "utf8");
    const generated = await generateReleaseSigningKeyPair({ privateKeyPath, publicKeyPath });
    assert.match(generated.fingerprint, /^[a-f0-9]{64}$/u);

    const signed = await signReleaseArtifact({ artifactPath, privateKeyPath, publicKeyPath, signaturePath });
    assert.equal(signed.artifact, path.basename(artifactPath));
    assert.equal(signed.publicKeyFingerprint, generated.fingerprint);

    const verified = await verifyReleaseArtifact({ artifactPath, publicKeyPath, signaturePath });
    assert.equal(verified.valid, true);

    await fs.writeFile(artifactPath, "tampered release", "utf8");
    await assert.rejects(
      () => verifyReleaseArtifact({ artifactPath, publicKeyPath, signaturePath }),
      /sha256/u,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
