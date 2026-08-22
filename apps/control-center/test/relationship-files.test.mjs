import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRelationshipFilesService, RelationshipFilesError } from "../electron/services/relationship-files.mjs";
import { loadRelationshipFiles, selectRelationshipContact } from "../src/features/relationship-settings/index.mjs";

async function project() {
  const root = process.platform === "win32" ? "D:\\Temp" : os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-relationship-files-"));
}

function service(projectRoot, fsOps = fs) {
  return createRelationshipFilesService({ settingsService: { load: () => ({ projectRoot }) }, fsOps });
}

test("relationship files use SUZU.md as the writable primary document", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "SUZU.md"), "# 相处规则\n@abilities.md\n@notes/season.md\n", "utf8");
  await fs.mkdir(path.join(root, "notes"));
  await fs.writeFile(path.join(root, "notes", "season.md"), "旧相处设定", "utf8");

  const current = service(root);
  const snapshot = await current.snapshot();
  assert.deepEqual(snapshot.files.map((item) => item.path), ["SUZU.md", "persona.md", "user.md", "notes/season.md"]);
  assert.equal(snapshot.files.find((item) => item.path === "SUZU.md")?.content, "# 相处规则\n");
  await current.save({ path: "notes/season.md", content: "新的相处设定" });
  assert.equal(await fs.readFile(path.join(root, "notes", "season.md"), "utf8"), "新的相处设定");
  const suzu = await fs.readFile(path.join(root, "SUZU.md"), "utf8");
  assert.match(suzu, /@abilities\.md/u);
  assert.match(suzu, /@notes\/season\.md/u);
});

test("custom files update SUZU.md references once and preserve existing relationship data", async () => {
  const root = await project();
  await fs.writeFile(path.join(root, "SUZU.md"), "# 用户原文\n@abilities.md\n@notes/bond.md\n@notes/bond.md\n", "utf8");
  const current = service(root);
  const result = await current.create({ path: "notes/bond.md", content: "相处备注" });
  assert.equal(result.files.find((item) => item.path === "notes/bond.md")?.content, "相处备注");
  const suzu = await fs.readFile(path.join(root, "SUZU.md"), "utf8");
  assert.equal((suzu.match(/^@notes\/bond\.md$/gmu) || []).length, 1);
  assert.match(suzu, /# 用户原文/u);
  assert.match(suzu, /@abilities\.md/u);
  await assert.rejects(() => current.create({ path: "notes/bond.md", content: "覆盖" }), RelationshipFilesError);
});

test("relationship files roll back a primary-reference transaction after a final write failure", async () => {
  const root = await project();
  const original = "# 用户原文\n@abilities.md\n";
  await fs.writeFile(path.join(root, "SUZU.md"), original, "utf8");
  await fs.writeFile(path.join(root, "persona.md"), "旧 persona", "utf8");
  let fail = true;
  const fsOps = {
    ...fs,
    rename: async (from, to) => {
      if (fail && path.basename(to) === "SUZU.md" && from.includes(".suzu-lives-")) {
        fail = false;
        const error = new Error("simulated SUZU failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(from, to);
    },
  };
  await assert.rejects(() => service(root, fsOps).save({ path: "persona.md", content: "新 persona" }), RelationshipFilesError);
  assert.equal(await fs.readFile(path.join(root, "persona.md"), "utf8"), "旧 persona");
  assert.equal(await fs.readFile(path.join(root, "SUZU.md"), "utf8"), original);
});

test("relationship files reject traversal, managed folders, and symlink escapes", async (t) => {
  const root = await project();
  const current = service(root);
  await assert.rejects(() => current.create({ path: "../escape.md" }), RelationshipFilesError);
  await assert.rejects(() => current.create({ path: "abilities.md" }), RelationshipFilesError);
  await assert.rejects(() => current.create({ path: ".suzu-lives/escape.md" }), RelationshipFilesError);
  await assert.rejects(() => current.create({ path: "PERSONA.md" }), RelationshipFilesError);
  await assert.rejects(() => current.create({ path: "C:\\escape.md" }), RelationshipFilesError);
  const outside = await project();
  await fs.writeFile(path.join(root, "SUZU.md"), "@linked.md\n", "utf8");
  try { await fs.symlink(path.join(outside, "outside.md"), path.join(root, "linked.md"), "file"); } catch (error) { if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; } throw error; }
  await assert.rejects(() => current.snapshot(), RelationshipFilesError);
});

test("relationship settings select SUZU.md after a contact switch", async () => {
  let renders = 0;
  let settingsReads = 0;
  const files = { status: "ready", files: [{ path: "SUZU.md", kind: "standard", exists: true, content: "# 阿澈" }] };
  const contacts = { contacts: [{ id: "contact-b", name: "阿澈" }], activeContact: { id: "contact-b", name: "阿澈" } };
  const context = {
    state: { relationshipFilePath: "notes/old.md", relationshipFilesError: "" },
    api: {
      conversation: { snapshot: async () => contacts, selectContact: async ({ id }) => { assert.equal(id, "contact-b"); return contacts; } },
      relationshipFiles: { snapshot: async () => files },
      settings: { get: async () => { settingsReads += 1; return { projectRoot: "D:/contacts/contact-b" }; } },
    },
    render: () => { renders += 1; },
  };

  await loadRelationshipFiles(context);
  assert.equal(context.state.relationshipFilePath, "SUZU.md");
  await selectRelationshipContact(context, "contact-b");
  assert.equal(context.state.relationshipFilePath, "SUZU.md");
  assert.equal(renders, 2);
  assert.equal(settingsReads, 2);
});
