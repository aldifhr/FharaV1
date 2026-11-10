import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runVerification } from "@/execution/verification";
import {
  compareWithBaseline,
  failureSignatures,
  newFailures,
  parsePorcelainZ,
} from "@/execution/verifyBaseline";

/**
 * R1 (multi-repo adoption): a failing verification step is re-run on the
 * pre-change tree and only NEW failures count.
 */

describe("failureSignatures", () => {
  const root = "/repo";

  it("reads tsc diagnostics without line numbers", () => {
    const out = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/repo/src/b.ts:10:2 - error TS2304: Cannot find name 'foo'.",
      "Found 2 errors.",
    ].join("\n");
    expect(failureSignatures(out, root)).toEqual([
      "ts|src/a.ts|TS2322|Type 'string' is not assignable to type 'number'.",
      "ts|src/b.ts|TS2304|Cannot find name 'foo'.",
    ]);
  });

  it("the same error on a shifted line is the same signature", () => {
    const before = failureSignatures("src/a.ts(3,7): error TS2322: X.", root);
    const after = failureSignatures("src/a.ts(9,1): error TS2322: X.", root);
    expect(newFailures(after, before)).toEqual([]);
  });

  it("reads ESLint stylish output and vitest failures", () => {
    const out = [
      "/repo/src/c.tsx",
      "  12:5  error  'x' is assigned a value but never used  no-unused-vars",
      "  13:1  warning  Unexpected console statement  no-console",
      "",
      " FAIL  tests/a.test.ts > math > adds 12ms",
      " × tests/a.test.ts > math > subtracts",
    ].join("\n");
    expect(failureSignatures(out, root)).toEqual([
      "eslint|src/c.tsx|no-unused-vars|'x' is assigned a value but never used",
      "test|tests/a.test.ts > math > adds",
      "test|tests/a.test.ts > math > subtracts",
    ]);
  });

  it("newFailures is a multiset difference", () => {
    expect(newFailures(["a", "a", "b"], ["a", "b"])).toEqual(["a"]);
    expect(newFailures(["a"], ["a", "a"])).toEqual([]);
  });

  it("a passing baseline makes every failure new; identical unnamed output is pre-existing", () => {
    expect(
      compareWithBaseline({ after: { code: 1, output: "src/a.ts(1,1): error TS1: x" }, before: { code: 0, output: "" }, root, cwd: root })
    ).toEqual({ verdict: "new", newFailures: ["ts|src/a.ts|TS1|x"] });
    expect(
      compareWithBaseline({ after: { code: 1, output: "boom in 12ms" }, before: { code: 1, output: "boom in 30ms" }, root, cwd: root })
    ).toEqual({ verdict: "pre_existing", matched: 0 });
    expect(
      compareWithBaseline({ after: { code: 1, output: "boom" }, before: { code: 1, output: "other" }, root, cwd: root })
    ).toEqual({ verdict: "unknown" });
  });

  it("parses porcelain -z entries including renames", () => {
    expect(parsePorcelainZ(" M src/a.ts\0?? new.ts\0 D gone.ts\0R  to.ts\0from.ts\0")).toEqual([
      { path: "src/a.ts", deleted: false },
      { path: "new.ts", deleted: false },
      { path: "gone.ts", deleted: true },
      { path: "to.ts", deleted: false },
      { path: "from.ts", deleted: true },
    ]);
  });
});

// A fake typecheck: prints a tsc-style error for every src file containing
// "BROKEN", and one for src/b.ts when src/a.ts no longer exports `x`.
const CHECK_SCRIPT = `
const fs = require("fs");
const path = require("path");
let failed = false;
for (const f of fs.readdirSync("src").sort()) {
  const text = fs.readFileSync(path.join("src", f), "utf8");
  if (text.includes("BROKEN")) { console.log("src/" + f + "(1,1): error TS2322: Type 'string' is not assignable to type 'number'."); failed = true; }
}
const a = fs.existsSync("src/a.ts") ? fs.readFileSync("src/a.ts", "utf8") : "";
if (!a.includes("export const x")) { console.log("src/b.ts(1,10): error TS2305: Module './a' has no exported member 'x'."); failed = true; }
process.exit(failed ? 1 : 0);
`;

const TEST_SCRIPT = `
const fs = require("fs");
const t = fs.readFileSync("src/a.ts", "utf8");
if (t.includes("FLAKY")) { console.log(" FAIL  tests/a.test.ts > legacy > known broken"); process.exit(1); }
if (t.includes("REGRESS")) { console.log(" FAIL  tests/a.test.ts > math > adds"); console.log(" FAIL  tests/a.test.ts > legacy > known broken"); process.exit(1); }
process.exit(0);
`;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-r1-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "r1-fixture", scripts: { typecheck: "node check.js", test: "node test.js" } })
  );
  await fs.writeFile(path.join(dir, "check.js"), CHECK_SCRIPT);
  await fs.writeFile(path.join(dir, "test.js"), TEST_SCRIPT);
  for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(dir, file), content);
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function worktrees(dir: string): number {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

describe("runVerification baseline (R1)", () => {
  it("a failure that reproduces on the pre-change tree is pre-existing and passes", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1; // BROKEN\n", "src/b.ts": "import { x } from './a';\n" });
    dirs.push(dir);
    // The task edits a.ts, the very file the old error is in: the
    // file-name heuristic alone would count it as the change's failure.
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const x = 1; // BROKEN\nexport const y = 2;\n");
    const result = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000 });
    const typecheck = result.checks.find((c) => c.name.endsWith(":typecheck"));
    expect(typecheck?.status).toBe("passed");
    expect(typecheck?.details).toMatch(/before this change \(pre-existing, ignored\)/);
    expect(result.checks.some((c) => c.status === "failed")).toBe(false);
    expect(worktrees(dir)).toBe(1);
  }, 60_000);

  it("the same check without the baseline counts it as the change's failure", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1; // BROKEN\n", "src/b.ts": "import { x } from './a';\n" });
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const x = 1; // BROKEN\nexport const y = 2;\n");
    const result = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000, baseline: false });
    expect(result.checks.find((c) => c.name.endsWith(":typecheck"))?.status).toBe("failed");
  }, 60_000);

  it("a change that breaks an untouched importer is new, though the heuristic called it pre-existing", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n", "src/b.ts": "import { x } from './a';\n" });
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const z = 1;\n");
    const withBaseline = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000 });
    const failed = withBaseline.checks.find((c) => c.name.endsWith(":typecheck"));
    expect(failed?.status).toBe("failed");
    expect(failed?.details).toMatch(/New since this change \(1\): src\/b\.ts: TS2305/);
    expect(failed?.files).toEqual(["src/b.ts"]);

    const heuristicOnly = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000, baseline: false });
    expect(heuristicOnly.checks.find((c) => c.name.endsWith(":typecheck"))?.status).toBe("passed");
    expect(worktrees(dir)).toBe(1);
  }, 60_000);

  it("only the NEW failed test counts; an old failing test alone passes", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1; // FLAKY\n", "src/b.ts": "" });
    dirs.push(dir);
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const x = 2; // FLAKY\n");
    const old = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000 });
    expect(old.checks.find((c) => c.name.endsWith(":test"))?.status).toBe("passed");

    await fs.writeFile(path.join(dir, "src/a.ts"), "export const x = 2; // REGRESS\n");
    const regress = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000 });
    const test = regress.checks.find((c) => c.name.endsWith(":test"));
    expect(test?.status).toBe("failed");
    expect(test?.details).toMatch(/New since this change \(1\): failed test: tests\/a\.test\.ts > math > adds/);
  }, 60_000);

  it("keeps the workspace's own unrelated edits in the baseline tree", async () => {
    const dir = await makeRepo({ "src/a.ts": "export const x = 1;\n", "src/b.ts": "import { x } from './a';\n", "src/c.ts": "ok\n" });
    dirs.push(dir);
    // The user broke c.ts themselves (uncommitted, not part of the task).
    await fs.writeFile(path.join(dir, "src/c.ts"), "BROKEN\n");
    await fs.writeFile(path.join(dir, "src/a.ts"), "export const x = 1;\nexport const y = 2;\n");
    const result = await runVerification({ workspacePath: dir, changedFiles: ["src/a.ts"], includeBuild: false, timeoutMs: 60_000, scopeFiles: [] });
    expect(result.checks.find((c) => c.name.endsWith(":typecheck"))?.status).toBe("passed");
  }, 60_000);
});
