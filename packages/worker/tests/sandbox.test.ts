import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  isWithinWorkspace,
  resolveSandboxPath,
  resolveSandboxPathAsync,
  SandboxError,
} from "@/tools/sandbox";

const ROOT = path.resolve("./workspaces/test-project");

describe("sandbox path", () => {
  it("allows normal relative paths", () => {
    expect(resolveSandboxPath(ROOT, "app/page.tsx")).toBe(path.join(ROOT, "app/page.tsx"));
    expect(resolveSandboxPath(ROOT, "src/index.ts")).toBe(path.join(ROOT, "src/index.ts"));
    expect(resolveSandboxPath(ROOT, "file.txt")).toBe(path.join(ROOT, "file.txt"));
  });

  it("blocks ../ escape", () => {
    expect(() => resolveSandboxPath(ROOT, "../secret.txt")).toThrow(SandboxError);
    expect(() => resolveSandboxPath(ROOT, "app/../../secret.txt")).toThrow(SandboxError);
    expect(() => resolveSandboxPath(ROOT, "../../etc/passwd")).toThrow(SandboxError);
  });

  it("blocks absolute paths outside workspace", () => {
    expect(() => resolveSandboxPath(ROOT, "/etc/passwd")).toThrow(SandboxError);
    expect(() => resolveSandboxPath(ROOT, "C:\\Windows\\System32\\evil.exe")).toThrow(SandboxError);
  });

  it("normalizes backslashes", () => {
    expect(() => resolveSandboxPath(ROOT, "app\\..\\..\\secret")).toThrow(SandboxError);
    // leading slash is also rejected as absolute
    expect(() => resolveSandboxPath(ROOT, "/app/page.tsx")).toThrow(SandboxError);
  });
});

describe("sandbox containment", () => {
  it("detects containment correctly", () => {
    expect(isWithinWorkspace(ROOT, path.join(ROOT, "a/b"))).toBe(true);
    expect(isWithinWorkspace(ROOT, path.resolve(ROOT, "..", "outside"))).toBe(false);
    expect(isWithinWorkspace(ROOT, ROOT)).toBe(true);
  });
});

describe("symlink-aware async resolution", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-sandbox-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-outside-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "export {};", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("resolves normal nested paths", async () => {
    const resolved = await resolveSandboxPathAsync(root, "src/index.ts");
    expect(resolved.toLowerCase()).toBe(
      path.join(await fs.realpath(root), "src", "index.ts").toLowerCase()
    );
  });

  it("blocks a symlinked directory that escapes the workspace", async () => {
    const link = path.join(root, "escape");
    try {
      await fs.symlink(outside, link, "junction");
    } catch {
      return; // Symlink creation is not permitted on this machine.
    }
    await expect(resolveSandboxPathAsync(root, "escape/secret.txt")).rejects.toBeInstanceOf(
      SandboxError
    );
  });

  it("blocks a symlinked file that escapes the workspace", async () => {
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "secret", "utf-8");
    const link = path.join(root, "secret-link.txt");
    try {
      await fs.symlink(secret, link, "file");
    } catch {
      return;
    }
    await expect(resolveSandboxPathAsync(root, "secret-link.txt")).rejects.toBeInstanceOf(
      SandboxError
    );
  });
});
