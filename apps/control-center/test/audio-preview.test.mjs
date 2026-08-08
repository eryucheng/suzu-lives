import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("voice preview media is explicitly permitted by the renderer security policy", async () => {
  const html = await fs.readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const audio = await fs.readFile(new URL("../src/features/create/audio.mjs", import.meta.url), "utf8");
  assert.match(html, /media-src 'self' blob: data:/u);
  assert.match(audio, /function previewObjectUrl/u);
  assert.match(audio, /function renderKeepingVoiceScroll/u);
  assert.match(audio, /candidateScrollTop = candidates\?\.scrollTop/u);
  assert.match(audio, /window\.requestAnimationFrame\(restore\)/u);
  assert.match(audio, /new Audio\(objectUrl\)/u);
  assert.doesNotMatch(audio, /new Audio\(dataUrl\)/u);
});
