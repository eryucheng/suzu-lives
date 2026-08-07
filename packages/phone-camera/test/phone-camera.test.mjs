import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createVisualReferenceLibrary } from "@suzu-lives/visual-reference-library";

import { buildPhonePrompt, expandReferences, PhoneCameraError, takePhonePhoto } from "../src/index.mjs";
import { parsePhoneCameraArgs, runPhoneCameraCli } from "../src/cli.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64");
async function temporary() { return fs.mkdtemp(path.join(os.tmpdir(), "suzu-phone-camera-")); }
function jsonResponse(value) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }

test("phone profiles preserve rear, selfie, and mirror camera constraints", () => {
  const rear = buildPhonePrompt({ scene: "桌上的晚饭", shot: "rear" }); const selfie = buildPhonePrompt({ scene: "窗边自拍", shot: "selfie" }); const mirror = buildPhonePrompt({ scene: "镜前穿搭", shot: "mirror" });
  assert.match(rear, /photographer and the phone are not visible/u);
  assert.match(selfie, /phone itself cannot appear/u);
  assert.match(mirror, /phone must be visibly held/u);
  assert.throws(() => buildPhonePrompt({ scene: "x", shot: "other" }), PhoneCameraError);
});

test("dry run keeps ordered asset metadata and does not create output", async () => {
  const agentRoot = await temporary(); const source = path.join(agentRoot, "fixture.png"); await fs.writeFile(source, png);
  const library = createVisualReferenceLibrary({ libraryRoot: path.join(agentRoot, "visual-references") }); await library.add({ source, id: "person.main", role: "identity", description: "人物" });
  const result = await takePhonePhoto({ agentRoot, options: { shot: "rear", scene: "雨后街道", dryRun: true, refs: ["person.main"] } });
  assert.equal(result.status, "dry-run"); assert.equal(result.backend, "api"); assert.equal(result.size, "1536x1024"); assert.match(result.prompt, /Visible scene/u);
  assert.deepEqual(result.references, [{ index: 1, id: "person.main", role: "identity", path: "visual-references/characters/person/main.png" }]);
  await assert.rejects(() => fs.stat(path.join(agentRoot, "phone-camera")), /ENOENT/u);
});

test("references expand requested asset and set order, then use the software-owned image engine", async () => {
  const agentRoot = await temporary(); const source = path.join(agentRoot, "fixture.png"); await fs.writeFile(source, png);
  const library = createVisualReferenceLibrary({ libraryRoot: path.join(agentRoot, "visual-references") }); await library.upsertSet({ id: "home", description: "卧室" }); await library.add({ source, id: "person.main", role: "identity", description: "人物", preserve: ["发型"], ignore: ["外套"], sets: ["home"] });
  const expanded = await expandReferences({ agentRoot, requested: ["home", "person.main"], maxImages: 8 }); assert.deepEqual(expanded.map((item) => item.id), ["person.main"]);
  let request; const result = await takePhonePhoto({ agentRoot, connection: { baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "fixture" }, fetchImpl: async (_url, options) => { request = options.body; return jsonResponse({ data: [{ b64_json: png.toString("base64") }] }); }, options: { shot: "mirror", scene: "在卧室镜前看穿搭", refs: ["home"], out: "phone-output" } });
  assert.equal(result.status, "ok"); assert.equal(result.shot, "mirror"); assert.deepEqual(result.references, ["person.main"]); assert.match(request.get("prompt"), /Do not inherit: 外套/u); assert.doesNotMatch(request.get("prompt"), /- Input image 1/u);
  assert.equal(await fs.stat(result.path).then((item) => item.isFile()), true);
});

test("phone camera keeps the 16-reference limit without changing the shared drawing default", async () => {
  const agentRoot = await temporary(); const source = path.join(agentRoot, "fixture.png"); await fs.writeFile(source, png);
  await fs.mkdir(path.join(agentRoot, "phone-camera"), { recursive: true }); await fs.writeFile(path.join(agentRoot, "phone-camera", "config.json"), JSON.stringify({ references: { max_images: 16 } }));
  const library = createVisualReferenceLibrary({ libraryRoot: path.join(agentRoot, "visual-references") }); await library.upsertSet({ id: "full-scene", description: "完整场景" });
  for (let index = 1; index <= 16; index += 1) await library.add({ source, id: "identity." + String(index).padStart(2, "0"), role: "identity", description: "人物 " + index, sets: ["full-scene"] });
  let request;
  const result = await takePhonePhoto({ agentRoot, connection: { baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "fixture" }, fetchImpl: async (_url, options) => { request = options.body; return jsonResponse({ data: [{ b64_json: png.toString("base64") }] }); }, options: { shot: "rear", scene: "十六张参考图的场景", refs: ["full-scene"], out: "phone-output" } });
  assert.equal(result.status, "ok"); assert.equal(result.references.length, 16); assert.equal(request.getAll("image[]").length, 16);
});

test("phone camera keeps its generated image local and rejects retired external send", async () => {
  const agentRoot = await temporary(); const customConfig = path.join(agentRoot, "custom", "image-config.json");
  await fs.mkdir(path.dirname(customConfig), { recursive: true }); await fs.mkdir(path.join(agentRoot, "phone-camera"), { recursive: true });
  await fs.writeFile(path.join(agentRoot, "phone-camera", "config.json"), JSON.stringify({ engine_config: "../custom/image-config.json" }));
  await fs.writeFile(customConfig, JSON.stringify({ delivery: { command: "fixture-external-delivery", session_key_env: "FIXTURE_PHONE_SESSION" } }));
  const result = await takePhonePhoto({
    agentRoot,
    connection: { baseUrl: "https://images.example.test/v1", model: "fixture", apiKey: "fixture" },
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
    options: { shot: "selfie", scene: "窗边", refs: [] },
  });
  assert.equal(result.sent, false);
  assert.equal(await fs.stat(result.path).then((value) => value.isFile()), true);
  assert.throws(() => parsePhoneCameraArgs(["--shot", "rear", "--scene", "街道", "--send"]), /不再支持 --send/u);
  assert.deepEqual(parsePhoneCameraArgs(["--shot", "rear", "--scene", "街道", "--ref", "a", "--ref", "b", "--dry-run", "--seed", "12"]), { shot: "rear", scene: "街道", refs: ["a", "b"], dryRun: true, seed: 12 });
});

test("phone camera CLI asks its caller for the selected image connection", async () => {
  const dataRoot = await temporary();
  let resolverInput;
  const result = await runPhoneCameraCli(["--data-root", dataRoot, "--agent-id", "fixture", "--shot", "rear", "--scene", "窗边", "--dry-run"], {
    environment: {},
    connectionResolver: async (input) => {
      resolverInput = input;
      return { baseUrl: "https://images.example.test/v1", model: "selected", apiKey: "selected-key" };
    },
  });
  assert.equal(result.status, "dry-run");
  assert.equal(resolverInput.kind, "phone-camera");
  assert.equal(resolverInput.dataRoot, dataRoot);
});
