import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveSandboxPath, SandboxError } from "../src/tools/sandbox";

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
