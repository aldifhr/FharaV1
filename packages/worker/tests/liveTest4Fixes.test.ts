import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyVerifyFailure,
  ensureWorktreeDependencies,
  mainCheckoutOf,
  verificationStatus,
} from "@/execution/verifyEnv";
import { runVerification } from "@/execution/verification";
import {
  exportedSymbols,
  isDocOnlyRequest,
  scopeViolations,
  scopeWarning,
  stripComments,
  testCaseNames,
} from "@/execution/scopeGuard";
import { newFilesOnlyFixWarning } from "@/services/runner/noTargetGuard";
import { fillMissingReasoning } from "@/services/runner/replan";
import { usageMetaFor, type FallbackHandle } from "@/effects/llmCall";
import { withSnapshotScope } from "@/llm/snapshots";
import { assertRepoPathExists, mainCheckoutOfWorktree, resolveRepoPath } from "@/api/convex/lib/workspacePath";
import type { ExecutionPlan } from "@/orchestrator/types";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-live4-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A fake linked worktree: <root>/main (checkout) + <root>/wt with a .git file. */
async function fakeWorktree(): Promise<{ main: string; wt: string }> {
  const main = path.join(root, "main");
  const wt = path.join(root, "wt");
  await fs.mkdir(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  await fs.mkdir(wt, { recursive: true });
  await fs.writeFile(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  return { main, wt };
}

describe("verify failure classification (env vs code)", () => {
  it("TS2688 (missing type definitions) is an environment failure", () => {
    const out = "error TS2688: Cannot find type definition file for 'node'.\n  The file is in the program because:\n    Entry point of type library 'node' specified in compilerOptions";
    const result = classifyVerifyFailure({ output: out, code: 2, changedFiles: ["src/lib/format.ts"] });
    expect(result.kind).toBe("env");
    expect(result.kind === "env" && result.reason).toContain("TS2688");
  });

  it("TS2307 for a bare package from an untouched file is env; from a changed file it is code", () => {
    const fromUntouched = "src/other.ts(1,20): error TS2307: Cannot find module 'vitest' or its corresponding type declarations.";
    expect(classifyVerifyFailure({ output: fromUntouched, code: 2, changedFiles: ["src/a.ts"] }).kind).toBe("env");
    const fromChanged = "src/a.ts(1,20): error TS2307: Cannot find module 'lodash' or its corresponding type declarations.";
    expect(classifyVerifyFailure({ output: fromChanged, code: 2, changedFiles: ["src/a.ts"] }).kind).toBe("code");
    const relative = "src/other.ts(1,20): error TS2307: Cannot find module './missing'.";
    expect(classifyVerifyFailure({ output: relative, code: 2, changedFiles: ["src/a.ts"] }).kind).toBe("code");
  });

  it("one real type error makes the whole failure a code failure", () => {
    const out = [
      "error TS2688: Cannot find type definition file for 'node'.",
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");
    expect(classifyVerifyFailure({ output: out, code: 2, changedFiles: ["src/a.ts"] }).kind).toBe("code");
  });

  it("command not found / spawn ENOENT / missing dependency at runtime are env", () => {
    expect(classifyVerifyFailure({ output: "sh: 1: tsc: not found", code: 127 }).kind).toBe("env");
    expect(classifyVerifyFailure({ output: "Error: spawn vitest ENOENT", code: 1 }).kind).toBe("env");
    expect(classifyVerifyFailure({ output: "Error: Cannot find module 'vitest'\nRequire stack:", code: 1 }).kind).toBe("env");
    expect(classifyVerifyFailure({ output: "", code: 127 }).kind).toBe("env");
  });

  it("an ordinary test failure is code", () => {
    const out = "FAIL src/format.test.js\n  ✕ formats 1000 (3 ms)\n  Expected: \"Rp 1.000\"\n  Received: \"Rp1.000\"";
    expect(classifyVerifyFailure({ output: out, code: 1, changedFiles: ["src/format.js"] }).kind).toBe("code");
  });

  it("verificationStatus: failure wins, env-only is skipped_env with the reason, all passed is passed", () => {
    expect(verificationStatus([{ name: "a", status: "failed", details: "x" }]).status).toBe("failed");
    const env = verificationStatus([
      { name: "root:typecheck", status: "inconclusive", environment: "TS2688: no types" },
      { name: "root:test", status: "passed" },
    ]);
    expect(env).toEqual({ status: "skipped_env", details: "root:typecheck: TS2688: no types" });
    expect(verificationStatus([{ name: "a", status: "passed" }]).status).toBe("passed");
    expect(verificationStatus([]).status).toBe("skipped");
  });
});

describe("worktree dependencies", () => {
  it("finds the main checkout of a linked worktree", async () => {
    const { main, wt } = await fakeWorktree();
    expect(await mainCheckoutOf(wt)).toBe(main);
    expect(await mainCheckoutOf(main)).toBeNull();
    expect(mainCheckoutOfWorktree(wt)).toBe(main);
  });

  it("symlinks the main checkout's node_modules into a worktree that lacks them", async () => {
    const { main, wt } = await fakeWorktree();
    await fs.mkdir(path.join(main, "node_modules", "@types", "node"), { recursive: true });
    await fs.mkdir(path.join(main, "packages", "app", "node_modules"), { recursive: true });
    await fs.mkdir(path.join(wt, "packages", "app"), { recursive: true });
    await fs.writeFile(path.join(wt, "package.json"), "{}");
    await fs.writeFile(path.join(wt, "packages", "app", "package.json"), "{}");
    const linked = await ensureWorktreeDependencies(wt, [path.join(wt, "packages", "app")]);
    expect(linked.sort()).toEqual([".", "packages/app"]);
    expect(await fs.realpath(path.join(wt, "node_modules"))).toBe(await fs.realpath(path.join(main, "node_modules")));
    // Idempotent: nothing more to link.
    expect(await ensureWorktreeDependencies(wt, [path.join(wt, "packages", "app")])).toEqual([]);
  });

  it("leaves a plain checkout alone", async () => {
    await fs.writeFile(path.join(root, "package.json"), "{}");
    expect(await ensureWorktreeDependencies(root)).toEqual([]);
  });

  it("runVerification reports an env failure as skipped (inconclusive + environment) and keeps going", async () => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {
          typecheck: "node -e \"console.log(\\\"error TS2688: Cannot find type definition file for 'node'.\\\"); process.exit(2)\"",
          test: "node -e \"process.exit(0)\"",
        },
      })
    );
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.js"), "module.exports = 1;\n");
    const result = await runVerification({ workspacePath: root, changedFiles: ["src/a.js"], includeBuild: false, timeoutMs: 30_000 });
    const typecheck = result.checks.find((check) => check.name.endsWith(":typecheck"));
    expect(typecheck?.status).toBe("inconclusive");
    expect(typecheck?.environment).toContain("TS2688");
    expect(typecheck?.details).toMatch(/^Skipped \(environment\)/);
    expect(result.checks.find((check) => check.name.endsWith(":test"))?.status).toBe("passed");
    expect(result.checks.some((check) => check.status === "failed")).toBe(false);
  }, 60_000);
});

describe("scope guard", () => {
  const FORMAT_OLD = [
    "/**",
    " * Format a number as Rupiah.",
    " */",
    "function formatRupiah(n) {",
    "  return 'Rp ' + n.toLocaleString('id-ID');",
    "}",
    "module.exports = { formatRupiah };",
    "",
  ].join("\n");

  it("recognises doc-only requests (EN/ID) and not feature requests", () => {
    expect(isDocOnlyRequest("tambahkan komentar JSDoc pada fungsi formatRupiah")).toBe(true);
    expect(isDocOnlyRequest("add JSDoc comments to src/lib/format.js")).toBe(true);
    expect(isDocOnlyRequest("only update the docs for formatRupiah")).toBe(true);
    expect(isDocOnlyRequest("tambahkan fungsi slugify(text) di src/lib/format.js beserta unit test-nya")).toBe(false);
    expect(isDocOnlyRequest("fix the bug in formatRupiah and add a comment")).toBe(false);
  });

  it("flags a JSDoc-only request that changes formatRupiah's output", () => {
    const rewritten = [
      "/** @param {number} n */",
      "function formatRupiah(n) {",
      "  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(n);",
      "}",
      "module.exports = { formatRupiah };",
      "",
    ].join("\n");
    const violations = scopeViolations("tambahkan komentar JSDoc pada formatRupiah", [
      { filePath: "src/lib/format.js", changeType: "modified", oldContent: FORMAT_OLD, newContent: rewritten },
    ]);
    expect(violations.map((v) => v.code)).toEqual(["doc_only_behavior"]);
  });

  it("allows a JSDoc-only change that only touches comments and formatting", () => {
    const documented = FORMAT_OLD.replace(
      " * Format a number as Rupiah.\n */",
      " * Format a number as Rupiah.\n * @param {number} n amount\n * @returns {string} e.g. \"Rp 1.000\"\n */"
    ).replace("  return 'Rp ' +", "  return 'Rp '  +  ");
    expect(
      scopeViolations("add JSDoc comments to formatRupiah", [
        { filePath: "src/lib/format.js", changeType: "modified", oldContent: FORMAT_OLD, newContent: documented },
      ])
    ).toEqual([]);
  });

  it("flags a dropped existing test case and a deleted test file", () => {
    const oldTest = "test('formats 1000', () => {});\ntest('formats 0', () => {});\n";
    const newTest = "test('formats 1000', () => {});\ntest('slugify lowercases', () => {});\n";
    const violations = scopeViolations("tambahkan fungsi slugify beserta unit test-nya", [
      { filePath: "src/lib/format.test.js", changeType: "modified", oldContent: oldTest, newContent: newTest },
      { filePath: "tests/old.spec.ts", changeType: "deleted", oldContent: oldTest },
    ]);
    expect(violations.map((v) => v.code)).toEqual(["deleted_test", "deleted_test"]);
    expect(violations[0].message).toContain('"formats 0"');
  });

  it("does not flag test removal when the request asks for it", () => {
    expect(
      scopeViolations("remove the flaky tests in format.test.js", [
        { filePath: "src/lib/format.test.js", changeType: "modified", oldContent: "it('a', () => {});\n", newContent: "" },
      ])
    ).toEqual([]);
  });

  it("flags a removed export (ESM and CommonJS)", () => {
    const violations = scopeViolations("add slugify to format.js", [
      {
        filePath: "src/lib/format.js",
        changeType: "modified",
        oldContent: FORMAT_OLD,
        newContent: "function slugify(t) { return t; }\nmodule.exports = { slugify };\n",
      },
      {
        filePath: "src/lib/util.ts",
        changeType: "modified",
        oldContent: "export function a() {}\nexport const b = 1;\n",
        newContent: "export function a() {}\n",
      },
    ]);
    expect(violations.map((v) => `${v.code}:${v.filePath}`)).toEqual([
      "removed_export:src/lib/format.js",
      "removed_export:src/lib/util.ts",
    ]);
  });

  it("helpers: test names, exports, comment stripping keep strings", () => {
    expect(testCaseNames("describe('x', () => { it.only(\"y\", () => {}); test.each([1])('z %s', () => {}) })")).toEqual(["x", "y", "z %s"]);
    expect(exportedSymbols("export default function main() {}\nexport { a as b, c };\nexports.d = 1;").sort()).toEqual(["b", "c", "d", "default", "main"]);
    expect(stripComments("const u = 'http://x'; // note\n/* block */ const v = 1;")).toBe("const u = 'http://x'; \n  const v = 1;");
  });

  it("the apply approval warning carries scope findings next to the no-target warning", () => {
    const warning = newFilesOnlyFixWarning("tambahkan komentar JSDoc pada formatRupiah", [
      { filePath: "src/lib/format.js", changeType: "modified", oldContent: FORMAT_OLD, newContent: FORMAT_OLD.replace("'Rp '", "'IDR '") },
    ]);
    expect(warning).toContain("Scope check");
    expect(scopeWarning([])).toBeNull();
    // The legacy no-target rule still works on its own.
    expect(newFilesOnlyFixWarning("fix the search bug", [{ filePath: "src/new.ts", changeType: "new" }])).toContain("every change creates a new file");
  });
});

describe("replan missing_reasoning fallback", () => {
  it("fills a deterministic reason only on the nodes that lack one", () => {
    const plan = {
      version: 2,
      goal: "g",
      strategy: "dag",
      subtasks: [
        { key: "a", title: "a", description: "a", kind: "code_change", capability: "backend-development", dependencies: [], order: 0 },
        { key: "b", title: "b", description: "b", kind: "code_change", capability: "backend-development", dependencies: [], order: 1, replanReasoning: "kept" },
      ],
    } as unknown as ExecutionPlan;
    const filled = fillMissingReasoning(plan, new Set(["a", "b"]), "Verification failed:   typecheck  TS2688");
    expect(filled.subtasks[0].replanReasoning).toMatch(/^\(auto-filled.*Verification failed: typecheck TS2688$/);
    expect(filled.subtasks[1].replanReasoning).toBe("kept");
  });
});

describe("workspace path resolution for git (worktreeNode)", () => {
  it("resolves relative project paths before any git call", () => {
    expect(resolveRepoPath("/abs/repo")).toBe("/abs/repo");
    expect(resolveRepoPath("live4-demo", { workspaceRoot: "/ws" })).toBe("/ws/live4-demo");
    expect(resolveRepoPath("live4-demo", { env: { WORKSPACE_ROOT: "./workspaces" }, cwd: "/srv/app" })).toBe("/srv/app/workspaces/live4-demo");
    expect(resolveRepoPath("live4-demo", { env: {}, cwd: "/srv/app" })).toBe("/srv/app/live4-demo");
    expect(() => resolveRepoPath("  ")).toThrow(/no workspace path/);
  });

  it("uses the task worktree's main checkout for a relative path on merge/discard", async () => {
    const { main, wt } = await fakeWorktree();
    expect(resolveRepoPath("live4-demo", { worktreePath: wt, env: {}, cwd: "/nowhere" })).toBe(main);
  });

  it("a missing path fails with a clear message instead of spawnSync ENOENT", () => {
    expect(() => assertRepoPathExists(path.join(root, "nope"), "nope")).toThrow(/does not exist.*configured as "nope"/);
    expect(() => assertRepoPathExists(root, root)).not.toThrow();
  });
});

describe("planner / decision usage rows carry callRole", () => {
  const handle = { connectionId: "c1", connectionName: "c", config: { provider: "openai", model: "m" } } as unknown as FallbackHandle;
  const result = { content: "x", inputTokens: 10, outputTokens: 5 } as any;

  it("an explicit role is kept outside the snapshot scope", () => {
    expect(usageMetaFor(handle, result).callRole).toBeUndefined();
    expect(usageMetaFor(handle, result, "planner").callRole).toBe("planner");
  });

  it("the scope role still applies when no role is given, and the explicit one wins", async () => {
    await withSnapshotScope({ callRole: "executor" }, async () => {
      expect(usageMetaFor(handle, result).callRole).toBe("executor");
      expect(usageMetaFor(handle, result, "decision").callRole).toBe("decision");
    });
    // The (input, output, estimated) form is unchanged.
    expect(usageMetaFor(handle, 10, 5, true).estimated).toBe(true);
  });
});
