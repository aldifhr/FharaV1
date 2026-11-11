#!/usr/bin/env node
// Code and UI guard ratchet: file length, unexplained suppressions, async assertions and the web
// UI rules, held to `scripts/code-budgets.json` so they only shrink.
//
// The baseline-ratchet design is adapted from GOAT `oxlint-plugin-goat/update-code-budgets.ts`
// and `rules/code-budget.ts` (https://github.com/goat-si/goat, commit 718f5b11), MIT License,
// Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors.
// Modified by Fhara, 2026-11: a plain Node script over `git ls-files` instead of an oxlint rule.
//
//   node scripts/code-budget.mjs            check; exit 1 on anything over its baseline
//   node scripts/code-budget.mjs --update   rewrite the baseline from the current tree
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, RULE_HELP, compareMeasures, isBudgeted, measureFile } from "./guards/rules.mjs";

export const BASELINE_PATH = path.join(import.meta.dirname, "code-budgets.json");

// Vendored reference trees and build output are not ours to hold to a budget.
const EXCLUDED = /^(?:node_modules|audit|plans|docs|e2e\/fixtures-ui\/out)\/|\/node_modules\/|^apps\/web\/(?:\.next|playwright-report|test-results)\//u;

/** Tracked plus untracked-but-not-ignored source files, repo-relative with forward slashes. */
export function listSourceFiles(root = REPO_ROOT) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((file) => file && isBudgeted(file) && !EXCLUDED.test(file) && existsSync(path.join(root, file)))
    .sort();
}

export function measureTree(root = REPO_ROOT) {
  const measured = {};
  for (const file of listSourceFiles(root)) {
    const measures = measureFile(file, readFileSync(path.join(root, file), "utf8"));
    if (Object.keys(measures).length) measured[file] = measures;
  }
  return measured;
}

export const readBaseline = () => JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

function main() {
  const measured = measureTree();
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(measured, null, 2)}\n`);
    console.log(`baseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)} (${Object.keys(measured).length} files)`);
    return;
  }
  const { problems, improved } = compareMeasures(measured, readBaseline());
  if (improved.length) {
    console.log(`${improved.length} baseline entr${improved.length === 1 ? "y has" : "ies have"} improved; run \`npm run check:budget -- --update\` to lock it in.`);
  }
  if (!problems.length) {
    console.log(`ok  code budget: ${Object.keys(measured).length} files with baselined findings, none over`);
    return;
  }
  for (const { file, rule, found, allowed } of problems) {
    console.error(`FAIL ${file}: ${rule} ${found} > ${allowed}. ${RULE_HELP[rule]}`);
  }
  process.exit(1);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
