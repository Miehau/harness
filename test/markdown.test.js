import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../public/markdown.js";

test("artifact markdown renders structure and escapes raw HTML", () => {
  const html = renderMarkdown(`## Result

| Area | Status |
|---|---|
| \`UI\` | **Ready** |

- First finding
- <script>alert(1)</script>`);

  assert.match(html, /<h3>Result<\/h3>/);
  assert.match(html, /<table>/);
  assert.match(html, /<code>UI<\/code>/);
  assert.match(html, /<strong>Ready<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
