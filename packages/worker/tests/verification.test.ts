import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runVerification } from "@/execution/verification";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "moagent-verify-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writePackage(
  directory: string,
  name: string,
  scripts: Record<string, string>
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name, scripts }, null, 2),
    "utf-8"
  );
  await fs.writeFile(path.join(directory, "ok.js"), "process.exit(0);\n", "utf-8");
  await fs.writeFile(
    path.join(directory, "fail.js"),
    'console.error("boom-failure");\nprocess.exit(1);\n',
    "utf-8"
  );
}

describe("verification", () => {
  it("runs checks only for packages touched by the changed files", async () => {
    const web = path.join(root, "apps", "web");
    const api = path.join(root, "apps", "api");
    await writePackage(web, "@app/web", {
      typecheck: "node ok.js",
      lint: "node ok.js",
      test: "node ok.js",
    });
    await writePackage(api, "@app/api", {
      typecheck: "node fail.js",
    });

    const result = await runVerification({
      workspacePath: root,
      changedFiles: ["apps/web/src/page.tsx"],
      includeBuild: false,
    });

    expect(result.checks.map((check) => check.name)).toEqual([
      "@app/web:typecheck",
      "@app/web:lint",
      "@app/web:test",
    ]);
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result.ran).not.toContain("@app/api:typecheck");
  });

  it("fails and reports the failing command output", async () => {
    const web = path.join(root, "apps", "web");
    await writePackage(web, "@app/web", {
      typecheck: "node ok.js",
      test: "node fail.js",
    });

    const result = await runVerification({
      workspacePath: root,
      changedFiles: ["apps/web/src/page.tsx"],
      includeBuild: false,
    });

    const failed = result.checks.find((check) => check.status === "failed");
    expect(failed?.name).toBe("@app/web:test");
    expect(failed?.details).toContain("boom-failure");
    expect(result.checks.map((check) => check.name)).toEqual([
      "@app/web:typecheck",
      "@app/web:test",
    ]);
  });

  it("passes when no package.json exists for a standalone file", async () => {
    await fs.writeFile(path.join(root, "flow.txt"), "ok", "utf-8");
    const result = await runVerification({
      workspacePath: root,
      changedFiles: ["flow.txt"],
    });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "verification", status: "passed" });
  });

  it("uses the root package for root-level changes", async () => {
    await writePackage(root, "root-app", {
      typecheck: "node ok.js",
      test: "node ok.js",
    });

    const result = await runVerification({
      workspacePath: root,
      changedFiles: ["package.json"],
      includeBuild: false,
    });

    expect(result.checks.map((check) => check.name)).toEqual([
      "root-app:typecheck",
      "root-app:test",
    ]);
  });
});
