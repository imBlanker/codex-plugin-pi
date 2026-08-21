// Source-contract regression test for issue #3:
// `codex_review`'s streaming onUpdate emitted `{ text }` instead of a partial
// ToolResult (`{ content: [...] }`), crashing pi's TUI renderer
// (render-utils.js `result.content.filter` on undefined) whenever the
// companion wrote to stderr mid-review. The extension runs under pi's jiti at
// runtime (not loadable in node --test), so the contract is asserted on
// source — the same shape the plugin's own gate handler reads
// (`event?.partialResult?.content?.map(...)`).
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = fs.readFileSync(path.join(ROOT, "extensions", "index.ts"), "utf8");

test("no tool emits the malformed `{ text }` partial result (issue #3)", () => {
  const offenders = SRC.match(/onUpdate\(\s*\{\s*text/g) ?? [];
  assert.deepEqual(offenders, [], "`onUpdate({ text ... })` is not a partial ToolResult — use { content: [{ type: 'text', text }] }");
});

test("codex_review streams stderr lines as partial ToolResult content blocks", () => {
  const start = SRC.indexOf('name: "codex_review"');
  assert.ok(start > 0, "codex_review tool found");
  const end = SRC.indexOf("pi.registerTool", start);
  const block = SRC.slice(start, end > 0 ? end : undefined);
  assert.match(block, /onUpdate\(\{\s*content:\s*\[\s*\{\s*type:\s*"text",\s*text:\s*line\s*\}\s*\]\s*\}\)/, "streaming callback must emit a partial ToolResult (content blocks)");
});

test("gate handler still reads the partialResult content shape (consistency)", () => {
  assert.match(SRC, /partialResult\?\.content\?\.map/);
});
