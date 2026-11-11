import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maskSecret, maskSecrets, unmaskText } from "../../lib/secretMask.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-abcdefgh1234567890XYZ";

test("an sk- key renders as its first 8 characters and five asterisks", () => {
  assert.equal(maskSecret(KEY), "sk-abcde*****");
  const { text, masks } = maskSecrets(`my key is ${KEY} ok`);
  assert.equal(text, "my key is sk-abcde***** ok");
  assert.deepEqual(masks, [{ masked: "sk-abcde*****", original: KEY }]);
  assert.equal(maskSecrets("sk-abcdefgh").text, "sk-abcde*****");
});

test("other token shapes are masked; ordinary words are not", () => {
  for (const secret of [
    "ghp_" + "a".repeat(36),
    "github_pat_" + "B".repeat(30),
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "AIza" + "x".repeat(35),
    "xoxb-1234567890-abcdef",
    "sk_live_" + "c".repeat(24),
    "sk-ant-api03-" + "d".repeat(30),
  ]) {
    assert.equal(maskSecrets(`k=${secret}`).text, `k=${secret.slice(0, 8)}*****`, secret);
  }
  for (const plain of ["sk-learn", "task-abcdefghijk", "risk-assessment", "use the ask-me flag", "desk-1234567890"]) {
    assert.equal(maskSecrets(plain).masks.length, 0, plain);
  }
});

test("markdown mode escapes the asterisks outside code only", () => {
  const { text } = maskSecrets(`key ${KEY} and \`${KEY}\`\n\`\`\`\n${KEY}\n\`\`\``, { markdown: true });
  assert.equal(text, "key sk-abcde\\*\\*\\*\\*\\* and `sk-abcde*****`\n```\nsk-abcde*****\n```");
});

test("copy returns the original text", () => {
  const content = `first ${KEY}, second sk-abcdeZZZZZZZZZ9 end`;
  const { text, masks } = maskSecrets(content);
  assert.equal(text, "first sk-abcde*****, second sk-abcde***** end");
  // Whole message selected → the original, each key restored in order.
  assert.equal(unmaskText(text, masks), content);
  // A partial selection restores the key it shows.
  const other = maskSecrets(`a ${KEY} b sk-zyxwvuts98765 c`);
  assert.equal(unmaskText("b sk-zyxwv***** c", other.masks), "b sk-zyxwvuts98765 c");
  // Text with no masked token is left alone; a cut token cannot be restored.
  assert.equal(unmaskText("first", masks), "first");
  assert.equal(unmaskText("sk-abc", masks), "sk-abc");
  assert.equal(unmaskText(text, []), text);
});

test("user messages render masked and copy through unmaskText", () => {
  const messageText = readFileSync(path.join(here, "../../components/chat/MessageText.tsx"), "utf8");
  assert.match(messageText, /maskSecretsIn\(content \?\? "", \{ markdown: true \}\)/);
  assert.match(messageText, /setData\("text\/plain", unmaskText\(selected, masks\)\)/);
  const list = readFileSync(path.join(here, "../../components/chat/MessageList.tsx"), "utf8");
  assert.match(list, /<MessageText content=\{m\.content \?\? ""\} maskSecrets \/>/);
  const thread = readFileSync(path.join(here, "../../components/TaskThreadPanel.tsx"), "utf8");
  assert.match(thread, /maskSecrets=\{isUser\}/);
});
