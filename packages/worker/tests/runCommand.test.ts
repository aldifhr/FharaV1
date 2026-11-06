import { describe, expect, it } from "vitest";
import { isCommandAllowed, shouldUseShell } from "@/tools/runCommand";

describe("command allowlist", () => {
  it("allows exact argv entries", () => {
    expect(isCommandAllowed("npm", ["run", "test"])).toBe(true);
    expect(isCommandAllowed("git", ["diff", "--no-color"])).toBe(true);
    expect(isCommandAllowed("npx", ["tsc", "--noEmit"])).toBe(true);
  });

  it("rejects prefix-bypass attempts", () => {
    expect(isCommandAllowed("npm", ["run", "test; rm -rf /"])).toBe(false);
    expect(isCommandAllowed("npm", ["run", "test", "--", "evil"])).toBe(false);
    expect(isCommandAllowed("git", ["status", "--short", "--extra"])).toBe(false);
    expect(isCommandAllowed("npm", ["run", "deploy"])).toBe(false);
  });

  it("rejects unknown commands and control characters", () => {
    expect(isCommandAllowed("rm", ["-rf", "."])).toBe(false);
    expect(isCommandAllowed("npm", ["run", "test\u0000"])).toBe(false);
  });

  it("rejects arguments that only start with an allowed prefix", () => {
    expect(isCommandAllowed("node", ["--version-evil"])).toBe(false);
  });
});

describe("shell handling for cross-platform exec", () => {
  it("uses a shell for npm/npx (Windows .cmd shims)", () => {
    expect(shouldUseShell("npm")).toBe(true);
    expect(shouldUseShell("npx")).toBe(true);
  });

  it("does not use a shell for real-executable binaries", () => {
    expect(shouldUseShell("git")).toBe(false);
    expect(shouldUseShell("node")).toBe(false);
    expect(shouldUseShell("rm")).toBe(false);
  });
});
