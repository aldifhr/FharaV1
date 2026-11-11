// D5: the Context Inspector's call-stats line (cache hit %, TTFT, tokens/s),
// server-rendered, plus the UI rules (theme tokens only: no tints, pills or pulse).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// Same React resolution as changesPane.test.mjs: the web app's React 19.
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
const CallStats = unwrap(await import("../../components/context/CallStats.tsx"));
const { uiRuleCounts } = await import("../../../../scripts/guards/rules.mjs");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("the inspector renders cache 82%, TTFT and tokens/s", () => {
  const html = renderToStaticMarkup(
    h(CallStats, { stats: { inputTokens: 12000, cachedInputTokens: 9840, outputTokens: 480, durationMs: 4420, ttftMs: 420 } })
  );
  assert.equal(text(html), "cache 82% · TTFT 420ms · 120 tokens/s");
});

test("estimated usage shows no cache share; nothing renders without stats", () => {
  assert.equal(renderToStaticMarkup(h(CallStats, { stats: { inputTokens: 100, cachedInputTokens: 80, usageEstimated: true } })), "");
  assert.equal(text(renderToStaticMarkup(h(CallStats, { stats: { ttftMs: 1500 } }))), "TTFT 2s");
});

test("CallStats follows the UI rules (theme tokens, no pill/badge/pulse)", () => {
  const counts = uiRuleCounts(readFileSync(new URL("../../components/context/CallStats.tsx", import.meta.url), "utf8"));
  for (const [rule, n] of Object.entries(counts)) assert.equal(n, 0, rule);
});
