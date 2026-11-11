import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OpenInPolicyError,
  checkLoopbackRequest,
  isLauncherId,
  launcherCommand,
  resolveOpenTarget,
} from "../../lib/openInPolicy.ts";

const req = (headers) => ({
  method: "POST",
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});
const local = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" };

test("loopback same-origin requests pass", () => {
  assert.equal(checkLoopbackRequest(req(local)).ok, true);
  assert.equal(checkLoopbackRequest(req({ host: "localhost:3000", origin: "http://localhost:3000" })).ok, true);
  assert.equal(checkLoopbackRequest(req({ host: "[::1]:3000", origin: "http://[::1]:3000" })).ok, true);
  assert.equal(checkLoopbackRequest(req({ ...local, "x-forwarded-for": "127.0.0.1" })).ok, true);
});

test("non-loopback requests are refused", () => {
  const refused = [
    { host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" }, // LAN host, even if FHARA_ALLOWED_HOSTS lists it
    { host: "fhara.example.com", origin: "https://fhara.example.com" },
    { ...local, "x-forwarded-for": "203.0.113.9" },
    { ...local, "x-forwarded-for": "127.0.0.1, 10.0.0.5" },
    { ...local, "x-real-ip": "10.0.0.5" },
    { ...local, forwarded: "for=198.51.100.7;proto=http" },
    { host: "127.0.0.1:3000" }, // no Origin
    { host: "127.0.0.1:3000", origin: "http://evil.test" },
    { host: "127.0.0.1:3000", origin: "http://127.0.0.1:4000" },
    { host: "127.0.0.1:3000", origin: "null" },
    { ...local, "sec-fetch-site": "cross-site" },
  ];
  for (const headers of refused) {
    assert.equal(checkLoopbackRequest(req(headers)).ok, false, JSON.stringify(headers));
  }
});

test("launchers are an allowlist and never a shell string", () => {
  assert.equal(isLauncherId("vscode"), true);
  for (const bad of ["bash", "code; rm -rf /", "__proto__", "constructor", "", 1, null]) {
    assert.equal(isLauncherId(bad), false, String(bad));
  }
  assert.deepEqual(launcherCommand("vscode", "/p", "linux"), { file: "code", args: ["/p"] });
  assert.deepEqual(launcherCommand("cursor", "/p", "darwin"), { file: "cursor", args: ["/p"] });
  assert.deepEqual(launcherCommand("files", "/p", "linux"), { file: "xdg-open", args: ["/p"] });
  assert.deepEqual(launcherCommand("files", "/p", "darwin"), { file: "open", args: ["/p"] });
  assert.deepEqual(launcherCommand("files", "C:\\p", "win32"), { file: "explorer.exe", args: ["C:\\p"] });
});

test("open-in refuses folders outside the project and worktree roots", async () => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "oi-out-")));
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "oi-base-")));
  const extWorktrees = realpathSync(mkdtempSync(path.join(tmpdir(), "oi-wt-")));
  mkdirSync(path.join(base, ".moagent-worktrees", "p", "task-1"), { recursive: true });
  mkdirSync(path.join(extWorktrees, "p", "task-2"), { recursive: true });
  writeFileSync(path.join(base, "file.txt"), "x");
  symlinkSync(outside, path.join(base, "escape"));
  const roots = [base, extWorktrees];

  assert.equal(await resolveOpenTarget(base, roots), base);
  assert.equal(await resolveOpenTarget(path.join(base, ".moagent-worktrees/p/task-1"), roots), path.join(base, ".moagent-worktrees/p/task-1"));
  assert.equal(await resolveOpenTarget(path.join(extWorktrees, "p/task-2"), roots), path.join(extWorktrees, "p/task-2"));

  for (const bad of [
    outside,
    "/etc",
    path.join(base, ".."),
    path.join(base, "../", path.basename(outside)),
    path.join(base, "escape"), // symlink pointing out
    path.join(base, "file.txt"), // not a folder
    path.join(base, "missing"),
    "relative/path",
    "",
    `${base}\0`,
  ]) {
    await assert.rejects(resolveOpenTarget(bad, roots), OpenInPolicyError, bad);
  }
  await assert.rejects(resolveOpenTarget(base, ["/definitely/not/here"]), OpenInPolicyError);
});
