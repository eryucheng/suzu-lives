import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("studio dialog keeps a form field focused while its parent rerenders", async () => {
  const source = await readFile(new URL("../src/react/create-studio-dialog.jsx", import.meta.url), "utf8");

  assert.match(source, /const onCloseRef = useRef\(onClose\);/u);
  assert.match(source, /onCloseRef\.current = onClose;/u);
  assert.match(source, /onCloseRef\.current\?\.\(\);/u);
  assert.match(source, /dialog\.contains\(document\.activeElement\)/u);
  assert.match(source, /\}, \[open\]\);/u);
  assert.doesNotMatch(source, /\}, \[onClose, open\]\);/u);
});
