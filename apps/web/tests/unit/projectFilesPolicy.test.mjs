import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeniedPath, resolveContainedFile, resolveWorkspaceBase, PathPolicyError } from "../../lib/projectFilesPolicy.ts";

test("denies secret-shaped paths", () => {
  for (const p of [".env", ".env.local", "apps/api/.env.production", ".env.example", "prod.env", ".git/config", "sub/.git/HEAD", ".git", "id_rsa", "keys/server.pem", "certs/a.key", ".npmrc", ".ssh/known_hosts", "x.p12"]) {
    assert.equal(isDeniedPath(p), true, p);
  }
  for (const p of ["src/app.ts", "README.md", "environment.ts", "keyboard.tsx", ".github/workflows/ci.yml", "docs/env.md"]) {
    assert.equal(isDeniedPath(p), false, p);
  }
});

test("realpath containment", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "pf-out-"));
  writeFileSync(path.join(outside, "secret.txt"), "s");
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "pf-base-")));
  mkdirSync(path.join(base, "src"));
  writeFileSync(path.join(base, "src", "a.ts"), "a");
  writeFileSync(path.join(base, ".env"), "K=v");
  symlinkSync(path.join(outside, "secret.txt"), path.join(base, "link.txt"));
  symlinkSync(path.join(base, ".env"), path.join(base, "innocent.txt"));

  assert.equal(await resolveContainedFile(base, "src/a.ts"), path.join(base, "src", "a.ts"));
  assert.equal(await resolveContainedFile(base, "/src/a.ts"), path.join(base, "src", "a.ts"));
  for (const bad of ["../../etc/passwd", "src/../../x", ".env", "link.txt", "innocent.txt", "missing.ts"]) {
    await assert.rejects(resolveContainedFile(base, bad), PathPolicyError, bad);
  }
});

test("workspace base resolution mirrors the worker", () => {
  assert.equal(resolveWorkspaceBase("/abs/p", {}), "/abs/p");
  assert.equal(resolveWorkspaceBase("proj", { WORKSPACE_ROOT: "./workspaces" }, "/repo/packages/worker"), "/repo/packages/worker/workspaces/proj");
  assert.equal(resolveWorkspaceBase("proj", { WORKSPACE_ROOT: "/ws" }, "/repo/packages/worker"), "/ws/proj");
  assert.throws(() => resolveWorkspaceBase("", {}));
});
