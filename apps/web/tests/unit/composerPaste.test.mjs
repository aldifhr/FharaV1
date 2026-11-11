import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACH_MAX_BYTES,
  COMPOSER_MAX_CHARS,
  PASTE_ATTACH_BYTES,
  attachmentBlock,
  composeMessage,
  formatBytes,
  looksBinary,
  pasteAction,
  pastedName,
  utf8Bytes,
} from "../../lib/composerPaste.ts";

test("thresholds: 32 KiB paste and a 120k-character composer", () => {
  assert.equal(PASTE_ATTACH_BYTES, 32 * 1024);
  assert.equal(COMPOSER_MAX_CHARS, 120_000);
});

test("a paste under 32 KiB stays inline; at 32 KiB it becomes an attachment", () => {
  assert.equal(pasteAction("a".repeat(PASTE_ATTACH_BYTES - 1), 0), "inline");
  assert.equal(pasteAction("a".repeat(PASTE_ATTACH_BYTES), 0), "attach");
});

test("the 32 KiB threshold counts UTF-8 bytes, not characters", () => {
  const text = "é".repeat(PASTE_ATTACH_BYTES / 2); // 2 bytes each
  assert.equal(text.length, PASTE_ATTACH_BYTES / 2);
  assert.equal(utf8Bytes(text), PASTE_ATTACH_BYTES);
  assert.equal(pasteAction(text, 0), "attach");
});

test("a small paste that would push the text past 120k becomes an attachment", () => {
  assert.equal(pasteAction("abc", COMPOSER_MAX_CHARS - 3), "inline");
  assert.equal(pasteAction("abcd", COMPOSER_MAX_CHARS - 3), "attach");
  // Replacing a selection frees its room.
  assert.equal(pasteAction("abcd", COMPOSER_MAX_CHARS - 3, 1), "inline");
});

test("a paste over the attachment limit is refused", () => {
  assert.equal(pasteAction("a".repeat(ATTACH_MAX_BYTES), 0), "attach");
  assert.equal(pasteAction("a".repeat(ATTACH_MAX_BYTES + 1), 0), "too_large");
});

test("pasted attachments get the next free name", () => {
  assert.equal(pastedName([]), "Pasted text 1.txt");
  const taken = [{ id: "a", name: "Pasted text 1.txt", text: "", bytes: 0 }, { id: "b", name: "Pasted text 3.txt", text: "", bytes: 0 }];
  assert.equal(pastedName(taken), "Pasted text 2.txt");
});

test("the message keeps the typed text and every attachment whole", () => {
  const big = "x".repeat(150_000);
  const msg = composeMessage("  please review  ", [{ name: "Pasted text 1.txt", text: big }, { name: "a.ts", text: "const a = 1;\n\n" }]);
  assert.ok(msg.startsWith("please review\n\n`Pasted text 1.txt`:\n```text\n"));
  assert.ok(msg.includes(big));
  assert.ok(msg.endsWith("`a.ts`:\n```ts\nconst a = 1;\n```"));
  assert.equal(composeMessage("", [{ name: "n.md", text: "hi" }]), "`n.md`:\n```md\nhi\n```");
});

test("a fence inside the attachment can't close the block", () => {
  const block = attachmentBlock({ name: "README", text: "a\n````\nb" });
  assert.ok(block.startsWith("`README`:\n`````\n"));
  assert.ok(block.endsWith("\n`````"));
});

test("binary content and sizes", () => {
  assert.equal(looksBinary("plain"), false);
  assert.equal(looksBinary("a\u0000b"), true);
  assert.equal(looksBinary("\uFFFD".repeat(9)), true);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(PASTE_ATTACH_BYTES), "32 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
});
