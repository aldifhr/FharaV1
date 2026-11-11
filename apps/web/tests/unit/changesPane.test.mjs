// Server-renders the Changes pane's presentational parts (ChangesHeader,
// ChecksList, ChangesFileList) and checks what a person reads, plus the UI
// rules (theme tokens only: no tints, pills or pulse).
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
const ChecksList = unwrap(await import("../../components/changes/ChecksList.tsx"));
const ChangesHeader = unwrap(await import("../../components/changes/ChangesHeader.tsx"));
const ChangesFileList = unwrap(await import("../../components/changes/ChangesFileList.tsx"));
const { uiRuleCounts } = await import("../../../../scripts/guards/rules.mjs");

const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const pushView = (flow, extra = {}) => ({
  taskId: "t1",
  source: "branch",
  branchName: "fhara/task-1",
  hasWorktree: true,
  base: "main",
  files: [],
  commit: { sha: "abc", message: "m", filesChanged: 2, ahead: 1, behind: 0, comparedTo: "main" },
  pushId: "p1",
  push: flow.push ?? null,
  pr: flow.pr ?? null,
  flow,
  ...extra,
});

test("committed, not pushed: branch → base, plain status and a primary Open PR", () => {
  const push = { status: "ready", pr: null };
  const html = renderToStaticMarkup(h(ChangesHeader, { view: pushView({ kind: "committed", push }), acting: null, onOpenPr: noop, onRefresh: noop }));
  const t = text(html);
  assert.match(t, /fhara\/task-1 → main/);
  assert.match(t, /Committed, not pushed · 1 ahead · 0 behind main/);
  assert.match(html, /bg-ink text-canvas[^"]*"[^>]*>.*Open PR/);
});

test("a push in flight hides Open PR", () => {
  const push = { status: "requested", pr: null };
  const t = text(renderToStaticMarkup(h(ChangesHeader, { view: pushView({ kind: "committed", push }), acting: null, onOpenPr: noop, onRefresh: noop })));
  assert.match(t, /Push requested/);
  assert.doesNotMatch(t, /Open PR/);
});

test("PR exists: #n state link, review and merge facts, Refresh", () => {
  const pr = { number: 42, url: "https://github.com/o/r/pull/42", state: "open", ciChecks: [], reviewState: "approved", mergeable: "conflict" };
  const push = { status: "pushed", pr };
  const html = renderToStaticMarkup(h(ChangesHeader, { view: pushView({ kind: "pr-exists", push, pr }), acting: null, onOpenPr: noop, onRefresh: noop }));
  const t = text(html);
  assert.match(t, /#42 open/);
  assert.match(t, /Approved/);
  assert.match(t, /Has conflicts/);
  assert.match(t, /Refresh/);
  assert.match(html, /href="https:\/\/github.com\/o\/r\/pull\/42"/);
});

test("worktree removed: no action, the reason in words", () => {
  const t = text(renderToStaticMarkup(h(ChangesHeader, { view: pushView({ kind: "worktree-gone", push: null }, { hasWorktree: false }), acting: null, onOpenPr: noop, onRefresh: noop })));
  assert.match(t, /Worktree removed/);
  assert.match(t, /can't be pushed from here/);
  assert.doesNotMatch(t, /Open PR/);
});

test("checks: one row per ciChecks entry with a word and a Details link", () => {
  const checks = [
    { name: "unit", status: "passed", url: "https://ci/u" },
    { name: "lint", status: "failed", url: "https://ci/l" },
    { name: "e2e", status: "pending" },
  ];
  const html = renderToStaticMarkup(h(ChecksList, { checks, onRefresh: noop }));
  assert.equal((html.match(/data-testid="changes-check-row"/g) ?? []).length, 3);
  const t = text(html);
  assert.match(t, /1 failed · 1 pending · 1 passed/);
  assert.match(t, /lint Failed Details/);
  assert.match(t, /e2e Pending/);
  assert.equal((html.match(/>Details/g) ?? []).length, 2);
});

test("file list: status letter, path, rename source and +a −d", () => {
  const files = [
    { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, source: "branch" },
    { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, source: "branch" },
    { path: "img.png", status: "added", additions: 0, deletions: 0, isBinary: true, source: "branch" },
  ];
  const html = renderToStaticMarkup(h(ChangesFileList, { files, selectedPath: "src/a.ts", onSelect: noop }));
  const t = text(html);
  assert.match(t, /M src\/a.ts \+3 −1/);
  assert.match(t, /R src\/new.ts ← src\/old.ts/);
  assert.match(t, /A img.png binary/);
  assert.match(html, /divide-y divide-line/);
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
});

test("the pane parts follow the UI rules (no tints, pills, pulse, raw hex)", async () => {
  const fs = await import("node:fs");
  for (const name of ["ChangesPane", "ChangesHeader", "ChangesFileList", "ChecksList"]) {
    const src = fs.readFileSync(new URL(`../../components/changes/${name}.tsx`, import.meta.url), "utf8");
    const counts = uiRuleCounts(src);
    for (const [rule, n] of Object.entries(counts)) assert.equal(n, 0, `${name}: ${rule}`);
  }
});
