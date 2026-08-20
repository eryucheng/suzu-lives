import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  collectAgentImageAttachmentIds,
  deleteAgentSessionStorage,
  agentProjectDirectoryName,
  encodeAgentSessionSegment,
  relocateAgentWorkspaceStorageSync,
  resolveAgentSessionStoragePaths,
} from "../electron/services/agent-session-storage.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-session-storage-"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeAttachmentObject(root, digest) {
  const filePath = path.join(root, digest.slice(0, 2), digest);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "image-bytes", "utf8");
  return filePath;
}

test("DSH contact cleanup removes one session, its indexes, and unshared native image bytes", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "data", "agent-runtime", "dsh");
  const deletedProject = path.join(root, "contacts", "contact-delete");
  const retainedProject = path.join(root, "contacts", "contact-keep");
  const deletedSessionId = "session-delete";
  const retainedSessionId = "session-keep";
  await fs.mkdir(deletedProject, { recursive: true });
  await fs.mkdir(retainedProject, { recursive: true });
  const paths = resolveAgentSessionStoragePaths({
    runtimeHome,
    projectRoot: deletedProject,
    sessionId: deletedSessionId,
  });
  await fs.mkdir(paths.sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(paths.sessionDirectory, "session.jsonl.zstd"), "durable-session", "utf8");

  await writeJson(paths.sessionProjectionCacheFile, {
    unit: { name: "session_projcache", version: 3 },
    global: null,
    tables: {
      sessions: {
        [deletedSessionId]: { seq: 4 },
        [retainedSessionId]: { seq: 9 },
      },
    },
  });
  await writeJson(paths.workspaceFile, {
    unit: { name: "workspace", version: 2 },
    global: {
      initialized: true,
      workspaceIds: ["workspace-delete", "workspace-keep"],
      archivedSessionIds: [deletedSessionId, retainedSessionId],
    },
    tables: {
      workspaces: {
        "workspace-delete": {
          path: deletedProject,
          title: "delete",
          sessionIds: [deletedSessionId],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        "workspace-keep": {
          path: retainedProject,
          title: "keep",
          sessionIds: [deletedSessionId, retainedSessionId],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  });
  const onlyDeletedDigest = "a".repeat(64);
  const sharedDigest = "b".repeat(64);
  const onlyDeletedObject = await writeAttachmentObject(paths.attachmentObjectsRoot, onlyDeletedDigest);
  const sharedObject = await writeAttachmentObject(paths.attachmentObjectsRoot, sharedDigest);

  const result = await deleteAgentSessionStorage({
    runtimeHome,
    projectRoot: deletedProject,
    sessionId: deletedSessionId,
    imageAttachmentIds: [`sha256:${onlyDeletedDigest}`, `sha256:${sharedDigest}`],
    protectedImageAttachmentIds: [`sha256:${sharedDigest}`],
  });

  assert.equal(result.sessionDirectoryRemoved, true);
  assert.equal(result.projectionCacheUpdated, true);
  assert.equal(result.workspaceIndexUpdated, true);
  assert.equal(result.attachmentObjectsRemoved, 1);
  assert.equal(result.attachmentObjectsRetained, 1);
  await assert.rejects(fs.stat(paths.sessionDirectory), { code: "ENOENT" });
  await assert.rejects(fs.stat(onlyDeletedObject), { code: "ENOENT" });
  await assert.doesNotReject(fs.stat(sharedObject));

  const projection = JSON.parse(await fs.readFile(paths.sessionProjectionCacheFile, "utf8"));
  assert.deepEqual(projection.tables.sessions, { [retainedSessionId]: { seq: 9 } });
  const workspace = JSON.parse(await fs.readFile(paths.workspaceFile, "utf8"));
  assert.deepEqual(workspace.global.workspaceIds, ["workspace-keep"]);
  assert.deepEqual(workspace.global.archivedSessionIds, [retainedSessionId]);
  assert.equal(Object.hasOwn(workspace.tables.workspaces, "workspace-delete"), false);
  assert.deepEqual(workspace.tables.workspaces["workspace-keep"].sessionIds, [retainedSessionId]);
});

test("DSH storage naming matches the harness JSONL project/session layout", () => {
  assert.equal(encodeAgentSessionSegment("session:1~x"), "session~003A1~007Ex");
  assert.equal(agentProjectDirectoryName("D:\\Suzu Contacts\\A"), "--D-Suzu~0020Contacts-A--");
});

test("DSH workspace relocation moves session artifacts and rewrites both JSONL encodings", async () => {
  const root = await temporaryRoot();
  const runtimeHome = path.join(root, "data", "agent-runtime", "dsh");
  const sourceProject = path.join(root, "data", "contacts", "contact-source");
  const targetProject = path.join(root, "external", "contacts", "contact-source");
  await fs.mkdir(sourceProject, { recursive: true });
  await fs.mkdir(targetProject, { recursive: true });

  const plain = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot: sourceProject, sessionId: "session-plain" });
  const zstd = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot: sourceProject, sessionId: "session-zstd" });
  await fs.mkdir(plain.sessionDirectory, { recursive: true });
  await fs.mkdir(zstd.sessionDirectory, { recursive: true });
  const plainHeader = { type: "session", version: 0, id: "session-plain", createdAt: 1, cwd: sourceProject };
  const zstdHeader = { type: "session", version: 0, id: "session-zstd", createdAt: 2, cwd: sourceProject };
  await fs.writeFile(path.join(plain.sessionDirectory, "session.jsonl"), `${JSON.stringify(plainHeader)}\n{"type":"event","seq":1}\n`, "utf8");
  const zstdOptions = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };
  const zstdEventFrame = zstdCompressSync(Buffer.from("{\"type\":\"event\",\"seq\":1}\n", "utf8"), zstdOptions);
  await fs.writeFile(path.join(zstd.sessionDirectory, "session.jsonl.zstd"), Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(zstdHeader)}\n`, "utf8"), zstdOptions),
    zstdEventFrame,
  ]));
  await writeJson(plain.workspaceFile, {
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds: ["source"], archivedSessionIds: [] },
    tables: {
      workspaces: {
        source: {
          path: sourceProject,
          title: "Suzu",
          sessionIds: ["session-plain", "session-zstd"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  });

  const result = relocateAgentWorkspaceStorageSync({
    runtimeHome,
    sourceProjectRoot: sourceProject,
    targetProjectRoot: targetProject,
  });
  assert.deepEqual(result, { headersUpdated: 2, sessionDirectoriesRelocated: 2, workspaceReferencesUpdated: 1 });

  const movedPlain = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot: targetProject, sessionId: "session-plain" });
  const movedZstd = resolveAgentSessionStoragePaths({ runtimeHome, projectRoot: targetProject, sessionId: "session-zstd" });
  await assert.rejects(fs.stat(plain.sessionDirectory), { code: "ENOENT" });
  await assert.doesNotReject(fs.stat(movedPlain.sessionDirectory));
  await assert.doesNotReject(fs.stat(movedZstd.sessionDirectory));
  const movedPlainHeader = JSON.parse((await fs.readFile(path.join(movedPlain.sessionDirectory, "session.jsonl"), "utf8")).split("\n")[0]);
  assert.equal(movedPlainHeader.cwd, targetProject);
  const movedZstdArtifact = await fs.readFile(path.join(movedZstd.sessionDirectory, "session.jsonl.zstd"));
  const movedZstdHeader = JSON.parse(zstdDecompressSync(movedZstdArtifact).toString("utf8"));
  assert.equal(movedZstdHeader.cwd, targetProject);
  assert.deepEqual(movedZstdArtifact.subarray(-zstdEventFrame.length), zstdEventFrame);
  const workspace = JSON.parse(await fs.readFile(movedPlain.workspaceFile, "utf8"));
  assert.equal(workspace.tables.workspaces.source.path, targetProject);
});

test("DSH attachment collector sees nested durable image references only", () => {
  const first = `sha256:${"c".repeat(64)}`;
  const second = `sha256:${"d".repeat(64)}`;
  const ids = collectAgentImageAttachmentIds([
    { event: { data: { message: { content: [{ type: "image", attachment: { attachmentId: first } }] } } } },
    { event: { data: { message: { content: [{ type: "tool-result", content: [{ attachmentId: second }] }] } } } },
    { event: { data: { attachmentId: "sha256:not-a-real-digest" } } },
  ]);
  assert.deepEqual(ids, [first, second]);
});
