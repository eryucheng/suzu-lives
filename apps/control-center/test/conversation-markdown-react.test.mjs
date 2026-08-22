import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const ROOT = new URL("..", import.meta.url);

test("chat renders structured Markdown while the composer keeps its plain-text mirror", async () => {
  const [page, styles, packageJson] = await Promise.all([
    readFile(new URL("src/react/conversation-page.jsx", ROOT), "utf8"),
    readFile(new URL("src/styles/conversation.css", ROOT), "utf8"),
    readFile(new URL("package.json", ROOT), "utf8"),
  ]);

  assert.match(page, /import ReactMarkdown from "react-markdown";/);
  assert.match(page, /import remarkGfm from "remark-gfm";/);
  assert.match(page, /import \{ hasMarkdownFormatting, shouldSubmitConversationOnEnter \} from "\.\.\/features\/conversation\/index\.mjs";/);
  assert.match(page, /function ConversationMarkdown\(\{ onOpenExternal, text \}\)/);
  assert.match(page, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(page, /function ConversationRenderedText\(\{ onOpenExternal, text \}\)/);
  assert.match(page, /<ConversationText text=\{draft\} \/>/);
  assert.match(page, /<ConversationRenderedText onOpenExternal=\{onOpenExternal\} text=\{block\.text\} \/>/);
  assert.match(page, /api\.settings\.openExternal\(url\)/);
  assert.match(styles, /\.conversation-markdown pre \{/);
  assert.match(styles, /\.conversation-markdown__table-scroll \{/);
  assert.match(styles, /\.conversation-markdown blockquote \{/);
  assert.match(packageJson, /"react-markdown": "\^10\.1\.0"/);
  assert.match(packageJson, /"remark-gfm": "\^4\.0\.1"/);

  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
  }, "# 标题\n\n- 第一项\n- 第二项\n\n`inline`\n\n| 名称 | 值 |\n| --- | --- |\n| A | B |\n\n```js\nconst answer = 42;\n```"));
  assert.match(html, /<h1>标题<\/h1>/u);
  assert.match(html, /<ul>/u);
  assert.match(html, /<code>inline<\/code>/u);
  assert.match(html, /<table>/u);
  assert.match(html, /<pre><code class="language-js">const answer = 42;\n<\/code><\/pre>/u);
});
