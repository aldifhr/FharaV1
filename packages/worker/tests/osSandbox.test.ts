import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  bwrapProfileArgs,
  isSandboxDenial,
  probeSandboxSupport,
  resetSandboxProbeForTest,
  resolveSandboxMode,
  sandboxCapability,
  sandboxStatus,
  SANDBOX_UNAVAILABLE,
  wrapCommand,
  writableRootsFor,
} from "@/tools/osSandbox";
import type { PtyHandle } from "@/tools/runPty";
import { runSandboxedShell } from "@/execution/shellRun";

// D6: command sandbox (bwrap). Everything here runs without bwrap: the
// probe is injected and the PTY spawn is a fake that records the argv.

let root: string;
const savedMode = process.env.SANDBOX_MODE;
const savedExtra = process.env.SANDBOX_EXTRA_WRITE_ROOTS;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fhara-d6-")));
});
afterEach(async () => {
  resetSandboxProbeForTest();
  if (savedMode === undefined) delete process.env.SANDBOX_MODE;
  else process.env.SANDBOX_MODE = savedMode;
  if (savedExtra === undefined) delete process.env.SANDBOX_EXTRA_WRITE_ROOTS;
  else process.env.SANDBOX_EXTRA_WRITE_ROOTS = savedExtra;
  await fs.rm(root, { recursive: true, force: true });
});

describe("resolveSandboxMode", () => {
  it("defaults to workspace-write on Linux when unset", () => {
    expect(resolveSandboxMode({}, "linux")).toEqual({ mode: "workspace-write", explicit: false });
    expect(resolveSandboxMode({ SANDBOX_MODE: "  " }, "linux")).toEqual({ mode: "workspace-write", explicit: false });
  });

  it("needs off to be set explicitly on Linux", () => {
    expect(resolveSandboxMode({ SANDBOX_MODE: "off" }, "linux")).toEqual({ mode: "off", explicit: true });
    expect(resolveSandboxMode({ SANDBOX_MODE: "read-only" }, "linux")).toEqual({ mode: "read-only", explicit: true });
  });

  it("reads an unset mode as off on hosts without bwrap, but keeps an explicit one", () => {
    expect(resolveSandboxMode({}, "darwin")).toEqual({ mode: "off", explicit: false, note: "no bwrap on darwin" });
    expect(resolveSandboxMode({ SANDBOX_MODE: "workspace-write" }, "win32")).toEqual({ mode: "workspace-write", explicit: true });
  });
});

describe("probe and status", () => {
  it("probes once and caches full / partial / off", () => {
    const calls: string[][] = [];
    resetSandboxProbeForTest((args) => {
      calls.push(args);
      return !args.includes("--unshare-pid");
    });
    expect(probeSandboxSupport("linux")).toBe("partial");
    expect(probeSandboxSupport("linux")).toBe("partial");
    expect(calls).toHaveLength(2); // full failed, partial passed, then cached
    resetSandboxProbeForTest(() => true);
    expect(probeSandboxSupport("linux")).toBe("full");
  });

  it("reports SANDBOX_UNAVAILABLE when the mode is not off and bwrap is not usable", () => {
    resetSandboxProbeForTest(() => false);
    const status = sandboxStatus({}, "linux");
    expect(status).toMatchObject({ mode: "workspace-write", support: "off", active: false, code: SANDBOX_UNAVAILABLE });
    expect(sandboxCapability(status)).toBe("sandbox:unavailable");
    expect(sandboxStatus({ SANDBOX_MODE: "off" }, "linux")).toMatchObject({ active: false, note: "sandbox off" });
    expect(sandboxStatus({ SANDBOX_MODE: "off" }, "linux").code).toBeUndefined();
  });

  it("is active with a working probe", () => {
    resetSandboxProbeForTest(() => true);
    const status = sandboxStatus({}, "linux");
    expect(status).toMatchObject({ active: true, support: "full", note: "sandbox workspace-write" });
    expect(sandboxCapability(status)).toBe("sandbox:workspace-write");
  });
});

describe("bwrapProfileArgs", () => {
  it("mounts / read-only, a private /tmp and the writable roots in workspace-write", () => {
    const args = bwrapProfileArgs({ mode: "workspace-write", writableRoots: ["/w", "/x"] });
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(args).toEqual(expect.arrayContaining(["--unshare-pid", "--die-with-parent"]));
    expect(args.join(" ")).toContain("--tmpfs /tmp --bind /w /w --bind /x /x");
  });

  it("binds nothing writable in read-only and drops the PID namespace when partial", () => {
    expect(bwrapProfileArgs({ mode: "read-only", writableRoots: ["/w"] })).not.toContain("--bind");
    const partial = bwrapProfileArgs({ mode: "workspace-write", writableRoots: [] }, "partial");
    expect(partial).not.toContain("--unshare-pid");
    expect(partial).not.toContain("--proc");
  });
});

describe("wrapCommand", () => {
  it("runs as-is when the mode is off, and refuses when bwrap is unusable", () => {
    resetSandboxProbeForTest(() => false);
    expect(wrapCommand("npm", ["test"], root, { env: { SANDBOX_MODE: "off" } })).toMatchObject({ kind: "unconfined", reason: "off", command: "npm" });
    const refused = wrapCommand("npm", ["test"], root, { env: {} });
    expect(refused.kind).toBe("unavailable");
    expect(refused.kind === "unavailable" && refused.message).toContain(SANDBOX_UNAVAILABLE);
  });

  it("wraps the argv in bwrap with the worktree writable", () => {
    resetSandboxProbeForTest(() => true);
    const wrapped = wrapCommand("npm", ["run", "test"], root, { env: {} });
    expect(wrapped.kind).toBe("sandboxed");
    if (wrapped.kind !== "sandboxed") return;
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args.slice(-6)).toEqual(["--chdir", root, "--", "npm", "run", "test"]);
    expect(wrapped.args.join(" ")).toContain(`--bind ${root} ${root}`);
  });

  it("runs unconfined only when asked (after a run_unconfined approval)", () => {
    resetSandboxProbeForTest(() => true);
    expect(wrapCommand("npm", ["test"], root, { env: {}, unconfined: true })).toMatchObject({ kind: "unconfined", reason: "approved", command: "npm" });
  });
});

describe("writableRootsFor", () => {
  it("adds a linked worktree's git common dir and absolute, existing extra roots", async () => {
    const common = path.join(root, "main", ".git");
    const gitDir = path.join(common, "worktrees", "wt");
    const worktree = path.join(root, "wt");
    const extra = path.join(root, "cache");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(worktree);
    await fs.mkdir(extra);
    await fs.writeFile(path.join(gitDir, "commondir"), "../..\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const roots = writableRootsFor(worktree, { SANDBOX_EXTRA_WRITE_ROOTS: `${extra}, relative/dir, ${path.join(root, "missing")}` });
    expect(roots).toEqual([worktree, common, extra]);
  });
});

it("detects the bwrap denial dialect", () => {
  expect(isSandboxDenial("touch: cannot touch '/home/u/x': Read-only file system")).toBe(true);
  expect(isSandboxDenial("Error: EROFS: read-only file system, open '/home/u/x'")).toBe(true);
  expect(isSandboxDenial("permission denied")).toBe(false);
});

interface Spawned {
  command: string;
  args: string[];
}

/** PTY fake: a bwrap spawn prints the denial and exits 1, an unconfined one succeeds. */
function recordingPty(spawned: Spawned[]) {
  return (command: string, args: string[]): PtyHandle => {
    spawned.push({ command, args });
    let dataCb: ((chunk: string) => void) | undefined;
    let exitCb: ((event: { exitCode: number }) => void) | undefined;
    setTimeout(() => {
      if (command === "bwrap") {
        dataCb?.("Error: EROFS: read-only file system, open '/home/u/x'\r\n");
        exitCb?.({ exitCode: 1 });
      } else {
        dataCb?.("ok\r\n");
        exitCb?.({ exitCode: 0 });
      }
    }, 0);
    return {
      pid: 999_999,
      write() {},
      kill() {},
      onData(cb) {
        dataCb = cb;
        return { dispose: () => undefined };
      },
      onExit(cb) {
        exitCb = cb;
        return { dispose: () => undefined };
      },
    };
  };
}

describe("runSandboxedShell (run_unconfined card)", () => {
  beforeEach(() => {
    process.env.SANDBOX_MODE = "workspace-write";
  });

  it("asks before an unconfined rerun after a denied write, and reruns on approval", async () => {
    resetSandboxProbeForTest(() => true);
    const spawned: Spawned[] = [];
    const events: string[] = [];
    const requestUnconfined = vi.fn(async () => ({ allowed: true, via: "allow" }));
    const result = await runSandboxedShell(
      root,
      "npm",
      ["run", "test"],
      { spawnImpl: recordingPty(spawned), onEvent: (type) => void events.push(type), requestUnconfined },
      true
    );
    expect(requestUnconfined).toHaveBeenCalledWith({ command: "npm", args: ["run", "test"] });
    expect(spawned.map((s) => s.command)).toEqual(["bwrap", "npm"]);
    expect(result).toMatchObject({ unconfined: true, code: 0 });
    expect(result.stdout).toContain("ok");
    expect(events).toEqual(["shell.command", "shell.sandbox_denied", "shell.command"]);
  });

  it("keeps the refused result when the card is declined", async () => {
    resetSandboxProbeForTest(() => true);
    const spawned: Spawned[] = [];
    const requestUnconfined = vi.fn(async () => ({ allowed: false, via: "deny", reason: "Denied by the user" }));
    const result = await runSandboxedShell(root, "npm", ["run", "test"], { spawnImpl: recordingPty(spawned), requestUnconfined }, true);
    expect(spawned).toHaveLength(1);
    expect(result.sandbox).toBe("denied");
    expect(result.unconfined).toBeUndefined();
    expect(result.stderr).toContain("not run unconfined");
  });

  it("never runs unconfined silently when bwrap is unavailable", async () => {
    resetSandboxProbeForTest(() => false);
    const spawned: Spawned[] = [];
    const requestUnconfined = vi.fn(async () => ({ allowed: false, via: "deny", reason: "Denied by the user" }));
    const result = await runSandboxedShell(root, "npm", ["run", "test"], { spawnImpl: recordingPty(spawned), requestUnconfined }, false);
    expect(spawned).toHaveLength(0);
    expect(requestUnconfined).toHaveBeenCalledTimes(1);
    expect(result.sandbox).toBe("unavailable");
    expect(result.stderr).toContain(SANDBOX_UNAVAILABLE);
  });

  it("does not ask when the mode is off", async () => {
    process.env.SANDBOX_MODE = "off";
    const spawned: Spawned[] = [];
    const requestUnconfined = vi.fn();
    const result = await runSandboxedShell(root, "npm", ["run", "test"], { spawnImpl: recordingPty(spawned), requestUnconfined }, false);
    expect(spawned.map((s) => s.command)).toEqual(["npm"]);
    expect(requestUnconfined).not.toHaveBeenCalled();
    expect(result.sandbox).toBeUndefined();
  });
});
