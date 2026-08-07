import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRelationshipFilesService, RelationshipFilesError } from "../electron/services/relationship-files.mjs";
import { loadRelationshipFiles, renderRelationshipSettings, selectRelationshipContact } from "../src/features/relationship-settings/index.mjs";

async function project() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-relationship-files-")); }
function service(projectRoot, fsOps = fs) { return createRelationshipFilesService({ settingsService: { load: () => ({ projectRoot }) }, fsOps }); }

test("relationship files read and atomically save only the selected project root", async () => {
  const root = await project(); await fs.writeFile(path.join(root, "CLAUDE.md"), "# 规则\n@abilities.md\n@notes/season.md\n", "utf8"); await fs.mkdir(path.join(root, "notes")); await fs.writeFile(path.join(root, "notes", "season.md"), "旧相处设定", "utf8");
  const files = await service(root).snapshot(); assert.deepEqual(files.files.map((item) => item.path), ["CLAUDE.md", "persona.md", "user.md", "notes/season.md"]); assert.equal(files.files.some((item) => item.path === "abilities.md"), false);
  await service(root).save({ path: "notes/season.md", content: "新的相处设定" }); assert.equal(await fs.readFile(path.join(root, "notes", "season.md"), "utf8"), "新的相处设定"); assert.match(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), /@abilities\.md/u);
});

test("custom Markdown creation inserts one CLAUDE reference without changing abilities references", async () => {
  const root = await project(); await fs.writeFile(path.join(root, "CLAUDE.md"), "# 用户原文\n@abilities.md\n@notes/bond.md\n@notes/bond.md\n", "utf8"); const current = service(root);
  const result = await current.create({ path: "notes/bond.md", content: "相处备注" }); assert.equal(result.files.find((item) => item.path === "notes/bond.md").content, "相处备注"); const claude = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"); assert.equal((claude.match(/^@notes\/bond\.md$/gmu) || []).length, 1); assert.match(claude, /# 用户原文/u); assert.match(claude, /@abilities\.md/u);
  await assert.rejects(() => current.create({ path: "notes/bond.md", content: "覆盖" }), RelationshipFilesError);
});

test("saving standard and custom relationship files creates and deduplicates their CLAUDE references", async () => {
  const root = await project(); await fs.writeFile(path.join(root, "CLAUDE.md"), "# 用户原文\n@persona.md\n@persona.md\n@notes/bond.md\n@notes/bond.md\n@abilities.md\n", "utf8"); await fs.mkdir(path.join(root, "notes")); await fs.writeFile(path.join(root, "notes", "bond.md"), "旧备注", "utf8"); const current = service(root);
  await current.save({ path: "persona.md", content: "新的 persona" });
  await current.save({ path: "user.md", content: "新的 user" });
  await current.save({ path: "notes/bond.md", content: "新的备注" });
  const claude = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.equal((claude.match(/^@persona\.md$/gmu) || []).length, 1);
  assert.equal((claude.match(/^@user\.md$/gmu) || []).length, 1);
  assert.equal((claude.match(/^@notes\/bond\.md$/gmu) || []).length, 1);
  assert.match(claude, /@abilities\.md/u);
  assert.equal(await fs.readFile(path.join(root, "persona.md"), "utf8"), "新的 persona");
  assert.equal(await fs.readFile(path.join(root, "user.md"), "utf8"), "新的 user");
  assert.equal(await fs.readFile(path.join(root, "notes", "bond.md"), "utf8"), "新的备注");
});

test("standard relationship save rolls back content and CLAUDE references after a final write failure", async () => {
  const root = await project(); const originalClaude = "# 用户原文\n@abilities.md\n"; await fs.writeFile(path.join(root, "CLAUDE.md"), originalClaude, "utf8"); await fs.writeFile(path.join(root, "persona.md"), "旧 persona", "utf8"); let fail = true;
  const fsOps = { ...fs, rename: async (from, to) => { if (fail && path.basename(to) === "CLAUDE.md" && from.includes(".suzu-lives-")) { fail = false; const error = new Error("simulated CLAUDE failure"); error.code = "EIO"; throw error; } return fs.rename(from, to); } };
  await assert.rejects(() => service(root, fsOps).save({ path: "persona.md", content: "新 persona" }), RelationshipFilesError);
  assert.equal(await fs.readFile(path.join(root, "persona.md"), "utf8"), "旧 persona");
  assert.equal(await fs.readFile(path.join(root, "CLAUDE.md"), "utf8"), originalClaude);
});

test("CLAUDE.md is normalized and never writes a self reference", async () => {
  const root = await project(); await fs.writeFile(path.join(root, "CLAUDE.md"), "# 旧规则\n", "utf8");
  await service(root).save({ path: "claude.md", content: "# 新规则\n" });
  const claude = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.equal(claude, "# 新规则\n");
  assert.doesNotMatch(claude, /^@claude\.md$/imu);
});

test("relationship files reject traversal, abilities, and symlink escapes", async (t) => {
  const root = await project(); const current = service(root); await assert.rejects(() => current.create({ path: "../escape.md" }), RelationshipFilesError); await assert.rejects(() => current.create({ path: "abilities.md" }), RelationshipFilesError); await assert.rejects(() => current.create({ path: ".CLAUDE/escape.md" }), RelationshipFilesError); await assert.rejects(() => current.create({ path: "PERSONA.md" }), RelationshipFilesError); await assert.rejects(() => current.create({ path: "C:\\escape.md" }), RelationshipFilesError);
  const outside = await project(); await fs.writeFile(path.join(root, "CLAUDE.md"), "@linked.md\n", "utf8"); try { await fs.symlink(path.join(outside, "outside.md"), path.join(root, "linked.md"), "file"); } catch (error) { if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("当前 Windows 环境不允许创建测试符号链接。"); return; } throw error; }
  await assert.rejects(() => current.snapshot(), RelationshipFilesError);
});

test("relationship settings view chooses a contact before presenting that contact's Markdown files", () => {
  const view = renderRelationshipSettings({
    state: {
      relationshipContacts: {
        contacts: [
          { id: "contact-a", name: "小苏" },
          { id: "contact-b", name: "阿澈" },
        ],
        activeContact: { id: "contact-b", name: "阿澈" },
      },
      relationshipFiles: { status: "ready", files: [
        { path: "CLAUDE.md", kind: "standard", exists: true, content: "# Rules" },
        { path: "persona.md", kind: "standard", exists: false, content: "" },
        { path: "notes/bond.md", kind: "custom", exists: true, content: "Keep calm" },
      ] },
      relationshipFilePath: "notes/bond.md",
      relationshipFilesError: "",
    },
  });
  assert.match(view, /相处设定/u);
  assert.match(view, /data-return-relationships/u);
  assert.match(view, /data-relationship-contact/u);
  assert.match(view, /relationship-contact-rail/u);
  assert.match(view, /relationship-profile-header/u);
  assert.match(view, /relationship-file-tab/u);
  assert.match(view, /小苏/u);
  assert.match(view, /阿澈/u);
  assert.match(view, /总设定/u);
  assert.match(view, /人格与相处方式/u);
  assert.match(view, /notes\/bond\.md/u);
  assert.match(view, /添加资料/u);
  assert.doesNotMatch(view, /abilities\.md/u);
  assert.doesNotMatch(view, /保存到联系人项目/u);

  const empty = renderRelationshipSettings({ state: { relationshipContacts: { contacts: [{ id: "contact-a", name: "小苏" }], activeContact: null }, relationshipFiles: { status: "needs-project", files: [] }, relationshipFilesError: "" } });
  assert.match(empty, /从左侧选择一位联系人/u);
  assert.doesNotMatch(empty, /relationshipFileContent/u);
});

test("relationship settings refreshes the contact list and reloads files after a contact switch", async () => {
  let settings = null;
  let renders = 0;
  const files = { status: "ready", files: [{ path: "CLAUDE.md", kind: "standard", exists: true, content: "# 阿澈" }] };
  const contacts = { contacts: [{ id: "contact-b", name: "阿澈" }], activeContact: { id: "contact-b", name: "阿澈" } };
  const context = {
    state: { relationshipFilePath: "notes/old.md", relationshipFilesError: "" },
    api: {
      conversation: {
        snapshot: async () => contacts,
        selectContact: async ({ id }) => {
          assert.equal(id, "contact-b");
          return contacts;
        },
      },
      relationshipFiles: { snapshot: async () => files },
      settings: { get: async () => ({ projectRoot: "D:/contacts/contact-b" }) },
    },
    render: () => { renders += 1; },
  };

  await loadRelationshipFiles(context);
  assert.deepEqual(context.state.relationshipContacts, contacts);
  assert.equal(context.state.relationshipFilePath, "CLAUDE.md");

  await selectRelationshipContact(context, "contact-b");
  assert.deepEqual(context.state.relationshipContacts, contacts);
  assert.equal(context.state.settings.projectRoot, "D:/contacts/contact-b");
  assert.equal(context.state.relationshipFilePath, "CLAUDE.md");
  assert.equal(renders, 2);
});
