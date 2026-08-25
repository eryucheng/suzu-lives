import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const readApp = (...parts) => readFileSync(resolve(HERE, "..", ...parts), "utf8");

test("startup loading uses the simple Suzu spinner", () => {
  const html = readApp("src", "index.html");
  const styles = readApp("src", "styles", "startup-loading.css");
  const startupTheme = readApp("assets", "startup-theme.js");

  assert.match(html, /<script src="\.\/startup-theme\.js"><\/script>[\s\S]*?<link rel="stylesheet" href="\.\/styles\/startup-loading\.css">/u);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\/startup-loading\.css">/u);
  assert.match(html, /id="loading"[^>]*role="status"[^>]*aria-busy="true"/u);
  assert.match(html, /<div class="loader" aria-hidden="true"><\/div>/u);
  assert.doesNotMatch(html, /<video|suzu-logo-formation|startup-motion-fallback/u);
  assert.match(styles, /\.loader[\s\S]*?animation: suzu-loading-spin \.8s linear infinite;/u);
  assert.match(styles, /@keyframes suzu-loading-spin/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(startupTheme, /requestedTheme === "dark" \? "dark" : "light"/u);
});

test("startup loading hides directly when the application is ready", () => {
  const app = readApp("src", "app.mjs");

  assert.doesNotMatch(app, /STARTUP_LOADING_EXIT_MS|startupLoadingExitTimeout|is-exiting/u);
  assert.match(app, /loading\.classList\.remove\("hidden"\)/u);
  assert.match(app, /loading\.classList\.add\("hidden"\)/u);
  assert.match(app, /loading\.setAttribute\("aria-busy", "false"\)/u);
  assert.match(app, /loading\.setAttribute\("aria-hidden", "true"\)/u);
});
