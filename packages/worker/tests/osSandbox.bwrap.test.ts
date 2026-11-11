import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSandboxProbeForTest } from "@/tools/osSandbox";
import { execCommandProcess } from "@/tools/runCommand";
import { runSandboxedShell } from "@/execution/shellRun";

// D6 on a real bwrap (Linux). Skipped where bwrap is missing or cannot
// create namespaces (most containers, macOS, Windows).
const hasBwrap =
  process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--", "true"], { stdio: "ignore" }).status === 0;

const savedMode = process.env.SANDBOX_MODE;
let root: string;

describe.skipIf(!hasBwrap)("bwrap command sandbox", () => {
  beforeAll(() => {
    process.env.SANDBOX_MODE = "workspace-write";
    resetSandboxProbeForTest();
  });
  afterAll(() => {
    if (savedMode === undefined) delete process.env.SANDBOX_MODE;
    else process.env.SANDBOX_MODE = savedMode;
    resetSandboxProbeForTest();
  });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fhara-d6-bwrap-")));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("refuses a write to $HOME from npm test with Read-only file system and asks run_unconfined", async () => {
    const target = path.join(os.homedir(), `fhara-d6-${process.pid}-${Date.now()}`);
    await fs.writeFile(path.join(root, "write-home.js"), `require("fs").writeFileSync(${JSON.stringify(target)}, "x");\n`);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "d6", private: true, scripts: { test: "node write-home.js" } }));
    const requestUnconfined = vi.fn(async () => ({ allowed: false, via: "deny", reason: "Denied by the user" }));
    const result = await runSandboxedShell(root, "npm", ["run", "test"], { requestUnconfined }, true);
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).toContain("read-only file system");
    expect(result.sandbox).toBe("denied");
    expect(requestUnconfined).toHaveBeenCalledWith({ command: "npm", args: ["run", "test"] });
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("allows writes inside the worktree", async () => {
    await execCommandProcess("sh", ["-c", "echo ok > inside.txt"], root);
    expect(await fs.readFile(path.join(root, "inside.txt"), "utf8")).toBe("ok\n");
  });

  it("gives the command a private /tmp", async () => {
    const hostMarker = path.join(os.tmpdir(), `fhara-d6-host-${process.pid}`);
    const innerMarker = `/tmp/fhara-d6-inner-${process.pid}`;
    await fs.writeFile(hostMarker, "host");
    try {
      const { stdout } = await execCommandProcess(
        "sh",
        ["-c", `echo inner > ${innerMarker} && (test -e ${hostMarker} && echo visible || echo hidden)`],
        root
      );
      expect(stdout.trim()).toBe("hidden");
      expect(existsSync(innerMarker)).toBe(false);
    } finally {
      await fs.rm(hostMarker, { force: true });
    }
  });
});
