import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { composeChatPrompt, isSafeChatModel, readChatModelFromSettings, runChatLlm } from "../src/tools/chatLlm";

describe("FharaV2-style chat model settings", () => {
  test("reads defaultModelSelection.model from settings.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fhara-settings-"));
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ defaultModelSelection: { instanceId: "opencode", model: "opencode/hy4-flash-free" } }));
    expect(await readChatModelFromSettings(file)).toBe("opencode/hy4-flash-free");
    await fs.writeFile(file, JSON.stringify({ model: "opencode/other" }));
    expect(await readChatModelFromSettings(file)).toBe("opencode/other");
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("missing or broken settings never throw", async () => {
    expect(await readChatModelFromSettings(path.join(os.tmpdir(), "no-such-settings.json"))).toBeNull();
  });

  test("the composed prompt keeps the system section and the last user turn", () => {
    const prompt = composeChatPrompt("You are the CTO.", [
      { role: "user", content: "halo" },
      { role: "assistant", content: "Halo juga." },
      { role: "user", content: "create new file hello.html" },
    ]);
    expect(prompt).toContain("You are the CTO.");
    expect(prompt).toContain("User: halo");
    expect(prompt).toContain("Assistant: Halo juga.");
    expect(prompt.trimEnd().endsWith("User: create new file hello.html")).toBe(true);
  });
});

describe("chat model id hardening", () => {
  test("real model ids pass", () => {
    expect(isSafeChatModel("opencode/hy4-flash-free")).toBe(true);
    expect(isSafeChatModel("anthropic/claude-sonnet-4@latest")).toBe(true);
    expect(isSafeChatModel("gpt-4o.mini")).toBe(true);
  });

  test("shell metacharacters and overlong ids are refused", () => {
    for (const bad of ["opencode/hy4 & calc", "m; echo pwned", "a|b", "$(whoami)", "a".repeat(201), ""]) {
      expect(isSafeChatModel(bad)).toBe(false);
    }
  });

  test("an unsafe model never reaches the CLI", async () => {
    const spawnImpl = vi.fn();
    const result = await runChatLlm({ system: "x", model: "bad; calc" }, { spawnImpl });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Invalid chat model id");
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
