import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildVoiceDesignRequest, createVoiceCandidates, deleteVoiceCandidate, readCandidates, readPreview, renameVoiceCandidate, retainVoiceCandidate, validateVoiceDesignInput, VoiceDesignError } from "../src/index.mjs";

function config() { return { baseUrl: "https://example.test/api/v1", designModel: "qwen-voice-design", targetModel: "qwen3-tts-vd-2026-01-26", namePrefix: "suzu", language: "zh", sampleRate: 24000, responseFormat: "wav" }; }
function input() { return { voicePrompt: "清晰自然的声音", previewText: "你好，这是一段试听。", count: 1 }; }
const credential = () => String.fromCharCode(120, 121, 122);

function brokenWav() {
  const audio = Buffer.alloc(52);
  audio.write("RIFF", 0, "ascii");
  audio.writeUInt32LE(0x7fffffff, 4);
  audio.write("WAVE", 8, "ascii");
  audio.write("fmt ", 12, "ascii");
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36, "ascii");
  audio.writeUInt32LE(0x7fffffff, 40);
  return audio;
}

test("builds the Qwen Voice Design request protocol exactly", () => {
  const request = buildVoiceDesignRequest(config(), input(), "suzu_000001");
  assert.equal(request.endpoint, "https://example.test/api/v1/services/audio/tts/customization");
  assert.deepEqual(request.payload, { model: "qwen-voice-design", input: { action: "create", target_model: "qwen3-tts-vd-2026-01-26", preferred_name: "suzu_000001", voice_prompt: "清晰自然的声音", preview_text: "你好，这是一段试听。", language: "zh" }, parameters: { sample_rate: 24000, response_format: "wav" } });
});

test("validates bounded input before making a request", () => {
  assert.throws(() => validateVoiceDesignInput({ voicePrompt: "a".repeat(2049), previewText: "ok", count: 1 }), VoiceDesignError);
  assert.throws(() => validateVoiceDesignInput({ voicePrompt: "ok", previewText: "a".repeat(1025), count: 1 }), VoiceDesignError);
  assert.throws(() => validateVoiceDesignInput({ voicePrompt: "ok", previewText: "ok", count: 21 }), VoiceDesignError);
});

test("stores mocked preview candidates under the supplied Agent data root and records successes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-"));
  const events = [];
  const candidates = await createVoiceCandidates({
    root, config: config(), input: input(), apiKey: credential(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ model: "qwen-voice-design", request_id: "request-1", usage: { output_tokens: 1 }, output: { voice: "voice-abc", preview_audio: { data: Buffer.from("preview").toString("base64") } } }) }),
    onSuccess: async (item) => events.push(item.request.requestId),
  });
  assert.equal(candidates[0].voiceId, "voice-abc");
  assert.deepEqual(events, ["request-1"]);
  const record = (await readCandidates(root))[0];
  assert.equal(record.voiceId, "voice-abc");
  assert.equal(record.voicePrompt, input().voicePrompt);
  assert.equal(record.previewText, input().previewText);
  assert.match(record.previewPath, /^preview-.+\.wav$/u);
  assert.equal(Buffer.from((await readPreview(root, candidates[0].id)).data, "base64").toString(), "preview");
  assert.equal(await fs.stat(path.join(root, "candidates.jsonl")).then((item) => item.isFile()), true);
});

test("aborts a timed out request without saving candidates or reporting ledger success", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-timeout-"));
  let successes = 0;
  await assert.rejects(() => createVoiceCandidates({
    root, config: config(), input: input(), apiKey: credential(), timeoutMs: 10,
    fetchImpl: (_endpoint, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    onSuccess: async () => { successes += 1; },
  }), /超时/u);
  assert.equal(successes, 0);
  assert.deepEqual(await readCandidates(root), []);
});

test("never follows a candidate preview path outside the Agent data root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-path-"));
  await fs.writeFile(path.join(root, "candidates.jsonl"), JSON.stringify({ id: "unsafe", voiceId: "voice-unsafe", createdAt: new Date().toISOString(), responseFormat: "wav", previewFile: "../outside.wav" }) + "\n");
  await assert.rejects(() => readPreview(root, "unsafe"), VoiceDesignError);
});

test("repairs invalid streaming WAV lengths for old and newly saved candidate previews", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-wav-"));
  const invalid = brokenWav();
  const candidates = await createVoiceCandidates({
    root, config: config(), input: input(), apiKey: credential(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { voice: "voice-wav", preview_audio: { data: invalid.toString("base64") } } }) }),
  });
  const first = candidates[0];
  const stored = await fs.readFile(path.join(root, (await readCandidates(root))[0].previewPath));
  assert.equal(stored.readUInt32LE(4), stored.length - 8);
  assert.equal(stored.readUInt32LE(40), stored.length - 44);

  const oldId = "old-wav";
  const oldFile = "preview-old-wav.wav";
  await fs.writeFile(path.join(root, oldFile), invalid);
  await fs.appendFile(path.join(root, "candidates.jsonl"), JSON.stringify({ id: oldId, voiceId: "voice-old", createdAt: new Date().toISOString(), responseFormat: "wav", previewFile: oldFile }) + "\n", "utf8");
  const repaired = Buffer.from((await readPreview(root, oldId)).data, "base64");
  assert.equal(repaired.readUInt32LE(4), repaired.length - 8);
  assert.equal(repaired.readUInt32LE(40), repaired.length - 44);
  assert.equal((await readPreview(root, first.id)).responseFormat, "wav");
});

test("renames and retains candidates without exposing provider identifiers as labels", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-retain-"));
  const candidates = await createVoiceCandidates({
    root, config: config(), input: input(), apiKey: credential(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { voice: "provider-voice", preview_audio: { data: Buffer.from("preview").toString("base64") } } }) }),
  });
  const id = candidates[0].id;
  assert.equal((await renameVoiceCandidate(root, { id, name: "温柔夜谈" })).displayName, "温柔夜谈");
  assert.equal((await retainVoiceCandidate(root, id)).retained, true);
  const saved = (await readCandidates(root))[0];
  assert.equal(saved.displayName, "温柔夜谈");
  assert.equal(saved.retained, true);
  assert.equal(saved.voiceId, "provider-voice");
});

test("deletes local candidate records and their preview file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-design-delete-"));
  const candidates = await createVoiceCandidates({
    root, config: config(), input: input(), apiKey: credential(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ output: { voice: "provider-voice", preview_audio: { data: Buffer.from("preview").toString("base64") } } }) }),
  });
  const [stored] = await readCandidates(root);
  const previewPath = path.join(root, stored.previewPath);

  const removed = await deleteVoiceCandidate(root, candidates[0].id);

  assert.equal(removed.id, candidates[0].id);
  assert.deepEqual(await readCandidates(root), []);
  await assert.rejects(fs.stat(previewPath), (error) => error?.code === "ENOENT");
});
