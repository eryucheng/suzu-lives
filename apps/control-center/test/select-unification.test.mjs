import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REACT_DIRECTORY = resolve(HERE, "..", "src", "react");
const REACT_SOURCES = [
  "conversation-page.jsx",
  "memory-page.jsx",
  "onboarding-dialog.jsx",
];

test("live React selection fields reuse the shared Suzu Select instead of browser-native menus", () => {
  for (const file of REACT_SOURCES) {
    const source = readFileSync(resolve(REACT_DIRECTORY, file), "utf8");
    assert.match(source, /\bSelect\b/u, `${file} should use the shared Select`);
  }

  for (const file of readdirSync(REACT_DIRECTORY)) {
    if (!file.endsWith(".jsx")) continue;
    const source = readFileSync(resolve(REACT_DIRECTORY, file), "utf8");
    assert.doesNotMatch(source, /<select\b/u, `${file} should not render a native select`);
  }
});

test("shared Select exposes a named button and a scroll-safe floating listbox", () => {
  const source = readFileSync(resolve(HERE, "..", "..", "..", "packages", "design-system", "src", "components", "Select", "Select.tsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "..", "..", "packages", "design-system", "src", "components", "Select", "Select.module.css"), "utf8");
  assert.match(source, /aria-label=\{ariaLabel\}/u);
  assert.match(source, /aria-haspopup="listbox"/u);
  assert.match(styles, /max-height:\s*min\(360px,\s*calc\(100dvh - 24px\)\)/u);
  assert.match(styles, /overflow-y:\s*auto/u);
});
