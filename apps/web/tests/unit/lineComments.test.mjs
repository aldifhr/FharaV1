// Paradev A4: line comment selection, composer keys and draft bar copy,
// plus server-rendered LineCommentComposer, LineComment and DraftCommentsBar
// held to the UI rules (theme tokens only: no tints, pills or pulse).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// The web app runs React 19 from its own node_modules; lucide-react (hoisted
// to the root) would otherwise pick up the root's React 18.
const webModules = new URL("../../node_modules/", import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (/^react(-dom)?(\\/|$)/.test(spec)) return next(spec, { ...ctx, parentURL: ${JSON.stringify(webModules)} });
  return next(spec, ctx);
}`)}`,
);
const Module = (await import("node:module")).default;
const webDir = new URL("../../", import.meta.url).pathname;
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (/^react(-dom)?(\/|$)/.test(request)) return originalResolve.call(this, request, { ...parent, paths: Module._nodeModulePaths(webDir) }, ...rest);
  return originalResolve.call(this, request, parent, ...rest);
};

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const unwrap = (m) => m.default?.default ?? m.default;
const LineCommentComposerModule = await import("../../components/changes/LineCommentComposer.tsx");
const { LineCommentComposer, LineComment } = LineCommentComposerModule.default ?? LineCommentComposerModule;
const DraftCommentsBar = unwrap(await import("../../components/changes/DraftCommentsBar.tsx"));
const lc = await import("../../lib/lineComments.ts");
const { KEYBINDING_ACTIONS, defaultKeybindings, matchesChord } = await import("../../lib/keybindings.ts");
const { uiRuleCounts } = await import("../../../../scripts/guards/rules.mjs");
const { readFileSync } = await import("node:fs");

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

// Lines 1-2 context, 3-5 added, old line 3 removed, then context.
const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,4 +1,6 @@",
  " one",
  " two",
  "-old three",
  "+three",
  "+four",
  "+five",
  " six",
  "",
].join("\n");
const rows = lc.parseDiff(DIFF);
const indexOf = (side, line) => rows.findIndex((r) => { const at = lc.rowLine(r); return at && at.side === side && at.line === line; });

test("parseDiff numbers both sides and drops the trailing empty row", () => {
  assert.equal(rows[0].type, "hunk");
  assert.deepEqual(rows.slice(1).map((r) => [r.type, r.oldNo, r.newNo]), [
    ["ctx", 1, 1], ["ctx", 2, 2], ["del", 3, null], ["add", null, 3], ["add", null, 4], ["add", null, 5], ["ctx", 4, 6],
  ]);
});

test("click line 3, shift-click line 5 → additions L3-L5, composer under line 5", () => {
  let sel = lc.selectRow(null, "a.ts", indexOf("additions", 3), false);
  assert.deepEqual(lc.selectionRange(rows, sel), { side: "additions", startLine: 3, endLine: 3, endIndex: indexOf("additions", 3) });
  sel = lc.selectRow(sel, "a.ts", indexOf("additions", 5), true);
  assert.deepEqual(lc.selectionRange(rows, sel), { side: "additions", startLine: 3, endLine: 5, endIndex: indexOf("additions", 5) });
  assert.deepEqual(lc.selectionBounds(sel), [indexOf("additions", 3), indexOf("additions", 5)]);
  assert.equal(lc.rangeLabel({ startLine: 3, endLine: 5 }), "L3-L5");
});

test("shift-click upward keeps the anchor; shift-click in another file starts over", () => {
  let sel = lc.selectRow(null, "a.ts", indexOf("additions", 5), false);
  sel = lc.selectRow(sel, "a.ts", indexOf("additions", 3), true);
  assert.equal(lc.selectionRange(rows, sel).startLine, 3);
  assert.equal(lc.selectionRange(rows, sel).endLine, 5);
  const other = lc.selectRow(sel, "b.ts", 2, true);
  assert.deepEqual(other, { path: "b.ts", anchor: 2, focus: 2 });
});

test("a removed line is on the deletions side; a range over both sides is mixed, numbered on the new side", () => {
  const del = lc.selectRow(null, "a.ts", indexOf("deletions", 3), false);
  assert.deepEqual(lc.selectionRange(rows, del), { side: "deletions", startLine: 3, endLine: 3, endIndex: indexOf("deletions", 3) });
  assert.equal(lc.rangeLabel({ startLine: 3, endLine: 3, side: "deletions" }), "L3 (old)");
  const mixed = lc.selectRow(del, "a.ts", indexOf("additions", 4), true);
  assert.deepEqual(lc.selectionRange(rows, mixed), { side: "mixed", startLine: 3, endLine: 4, endIndex: indexOf("additions", 4) });
  assert.equal(lc.selectionRange(rows, { path: "a.ts", anchor: 0, focus: 0 }), null, "a hunk row is not a line");
});

test("a stored comment shows under its last line; a line gone from the diff falls to the end", () => {
  assert.equal(lc.annotationRow(rows, { side: "additions", endLine: 5 }), indexOf("additions", 5));
  assert.equal(lc.annotationRow(rows, { side: "deletions", endLine: 3 }), indexOf("deletions", 3));
  assert.equal(lc.annotationRow(rows, { side: "additions", endLine: 99 }), rows.length - 1);
});

test("composer keys: Mod+Enter adds only with text, Esc closes only when empty, IME is ignored", () => {
  const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(lc.composerKeyAction(key("Enter", { metaKey: true }), "fix this"), "submit");
  assert.equal(lc.composerKeyAction(key("Enter", { ctrlKey: true }), "fix this"), "submit");
  assert.equal(lc.composerKeyAction(key("Enter", { ctrlKey: true }), "   "), null);
  assert.equal(lc.composerKeyAction(key("Enter"), "fix this"), null, "plain Enter is a newline");
  assert.equal(lc.composerKeyAction(key("Escape"), ""), "close");
  assert.equal(lc.composerKeyAction(key("Escape"), "typed"), null, "Esc never discards text");
  assert.equal(lc.composerKeyAction(key("Enter", { metaKey: true, isComposing: true }), "x"), null);
});

test("draft bar copy and refusal reasons are plain English", () => {
  assert.equal(lc.draftCountText(1), "1 draft comment");
  assert.equal(lc.draftCountText(3), "3 draft comments");
  assert.equal(lc.sendLabel(1), "Send 1 comment");
  assert.equal(lc.sentText(1), "Sent in round 1");
  for (const reason of ["no_drafts", "fix_running", "worktree_gone", "task_running", "thread_closed"]) {
    const t = lc.refusalText(reason);
    assert.match(t, /^[A-Z][^_]+\.$/, `${reason} → ${t}`);
  }
  assert.match(lc.refusalText("fix_running"), /fix is already running/);
  assert.equal(lc.commentStatusText({ status: "draft" }), "Draft");
  assert.equal(lc.commentStatusText({ status: "sent", round: 2, outdated: true }), "Sent in round 2 · Outdated: the branch moved since this comment");
});

test("sendRound has a rebindable default of Mod+Shift+Enter", () => {
  assert.ok(KEYBINDING_ACTIONS.some((a) => a.id === "sendRound"));
  const chord = defaultKeybindings().sendRound;
  assert.equal(chord, "Mod+Shift+Enter");
  assert.ok(matchesChord({ key: "Enter", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, chord));
  assert.ok(!matchesChord({ key: "Enter", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, chord));
});

test("DraftCommentsBar: count and Send, then Sent in round N, refusal as a sentence", () => {
  assert.equal(renderToStaticMarkup(h(DraftCommentsBar, { draftCount: 0, sending: false, lastRound: null, refusal: null, onSend: noop })), "");
  const one = renderToStaticMarkup(h(DraftCommentsBar, { draftCount: 1, sending: false, lastRound: null, refusal: null, onSend: noop }));
  assert.match(text(one), /1 draft comment Send 1 comment/);
  assert.match(one, /bg-ink[^"]*text-canvas/);
  const sent = text(renderToStaticMarkup(h(DraftCommentsBar, { draftCount: 0, sending: false, lastRound: 1, refusal: null, onSend: noop })));
  assert.equal(sent, "Sent in round 1");
  const refused = text(renderToStaticMarkup(h(DraftCommentsBar, { draftCount: 2, sending: false, lastRound: null, refusal: "task_running", onSend: noop })));
  assert.match(refused, /The task is still running\. Send these comments once it finishes\./);
  assert.doesNotMatch(refused, /task_running/);
});

test("composer and comment render plain text; drafts can be edited and deleted, sent ones cannot", () => {
  const composer = text(renderToStaticMarkup(h(LineCommentComposer, { label: "a.ts L3-L5", onSubmit: noop, onCancel: noop })));
  assert.match(composer, /Comment on a\.ts L3-L5/);
  assert.match(composer, /Add comment/);
  const draft = text(renderToStaticMarkup(h(LineComment, { comment: { _id: "c1", path: "a.ts", side: "additions", startLine: 3, endLine: 5, body: "Use the token", status: "draft" }, onEdit: noop, onDelete: noop })));
  assert.match(draft, /Use the token L3-L5 · Draft Edit Delete/);
  const sent = text(renderToStaticMarkup(h(LineComment, { comment: { _id: "c2", path: "a.ts", side: "additions", startLine: 3, endLine: 3, body: "x", status: "sent", round: 1, outdated: true }, onEdit: noop, onDelete: noop })));
  assert.match(sent, /L3 · Sent in round 1 · Outdated/);
  assert.doesNotMatch(sent, /Edit|Delete/);
});

test("new A4 files keep the UI rules (no tints, hex, pills or pulse; no @name)", () => {
  for (const file of ["components/changes/LineCommentComposer.tsx", "components/changes/DraftCommentsBar.tsx", "components/changes/useLineComments.tsx"]) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.deepEqual(uiRuleCounts(src), { pulse: 0, pill: 0, tint: 0, hex: 0 }, file);
    assert.doesNotMatch(src, /["'`>][^"'`<]*@[a-z][\w-]*/i, `${file} has @name copy`);
  }
});
