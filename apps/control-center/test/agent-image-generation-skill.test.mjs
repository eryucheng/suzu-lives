import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import {
  createVisualReferenceLibrary,
  resolveAgentVisualReferenceLibraryRoot,
  resolveSharedVisualReferenceLibraryRoot,
} from "@suzu-lives/visual-reference-library";
import {
  imageGenerationVisualReferenceSkillDetail,
  resolveImageGenerationVisualReferenceRegistryPath,
} from "../electron/services/agent-image-generation-skill.mjs";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

async function fixture() {
  const parent = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "suzu-lives-image-skill-"));
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const source = path.join(root, "source.png");
  await fs.mkdir(path.join(projectRoot, ".suzu-lives"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".suzu-lives", "contact.json"), JSON.stringify({
    id: "contact-11111111-1111-1111-1111-111111111111",
    agentId: "agent-visual-skill-test",
  }));
  await fs.writeFile(source, PNG);
  return { dataRoot, projectRoot, source };
}

test("image-generation Skill writes a combined visual-reference registry for the Agent to inspect", async () => {
  const { dataRoot, projectRoot, source } = await fixture();
  const agentRoot = resolveAgentDataRoot({ dataRoot, projectRoot });
  const contactLibrary = createVisualReferenceLibrary({
    libraryRoot: resolveAgentVisualReferenceLibraryRoot(agentRoot),
  });
  const sharedLibrary = createVisualReferenceLibrary({
    libraryRoot: resolveSharedVisualReferenceLibraryRoot(dataRoot),
  });
  await contactLibrary.upsertSet({ id: "home.kitchen", description: "这位联系人的厨房多角度参考" });
  await contactLibrary.add({ source, id: "person.main", role: "identity", description: "联系人本人" });
  await contactLibrary.add({
    source,
    id: "home.kitchen.warm",
    role: "location",
    description: "暖色开放式厨房，木质台面",
    sets: ["home.kitchen"],
  });
  await sharedLibrary.add({ source, id: "home.bedroom.soft", role: "location", description: "米白色卧室和落地灯" });

  const detail = await imageGenerationVisualReferenceSkillDetail({ dataRoot, projectRoot });
  const kitchenPath = await contactLibrary.assetPath("home.kitchen.warm");
  const bedroomPath = await sharedLibrary.assetPath("home.bedroom.soft");
  const registryPath = resolveImageGenerationVisualReferenceRegistryPath({ dataRoot, projectRoot });
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));

  assert.match(detail, /视觉参考注册表/u);
  assert.match(detail, /Get-Content -Raw -LiteralPath/u);
  assert.ok(detail.includes(registryPath));
  assert.doesNotMatch(detail, /home\.kitchen\.warm/u);
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.references.find((entry) => entry.scope === "contact" && entry.id === "home.kitchen.warm"), {
    scope: "contact",
    id: "home.kitchen.warm",
    role: "location",
    description: "暖色开放式厨房，木质台面",
    path: kitchenPath,
    preserve: [],
    ignore: [],
    sets: ["home.kitchen"],
  });
  assert.deepEqual(registry.references.find((entry) => entry.scope === "shared" && entry.id === "home.bedroom.soft"), {
    scope: "shared",
    id: "home.bedroom.soft",
    role: "location",
    description: "米白色卧室和落地灯",
    path: bedroomPath,
    preserve: [],
    ignore: [],
    sets: [],
  });
  assert.deepEqual(registry.sets.find((entry) => entry.scope === "contact" && entry.id === "home.kitchen"), {
    scope: "contact",
    id: "home.kitchen",
    description: "这位联系人的厨房多角度参考",
    assets: [{ id: "home.kitchen.warm", role: "location" }],
  });
  await sharedLibrary.add({ source, id: "object.lamp", role: "object", description: "床头暖光台灯" });
  await imageGenerationVisualReferenceSkillDetail({ dataRoot, projectRoot });
  const refreshed = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(refreshed.references.some((entry) => entry.scope === "shared" && entry.id === "object.lamp"), true);
});

test("image-generation Skill omits reference detail without an active contact data root", async () => {
  assert.equal(await imageGenerationVisualReferenceSkillDetail({ dataRoot: "", projectRoot: "" }), "");
});
