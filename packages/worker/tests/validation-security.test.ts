import { describe, expect, it, vi } from "vitest";
import { maskSecrets, maskStringSecrets } from "@/governance/tools";
import { tool_call, tool_search } from "@/governance/registry";
import { routeCapability } from "@/orchestrator/capabilities";
import type { AgentDefinition } from "@/orchestrator/types";

describe("security validation (worker)", () => {
  it("maskSecrets redacts provider-shaped keys", () => {
    expect(maskStringSecrets("sk-12345678abcdef")).toContain("[REDACTED]");
    expect(maskStringSecrets("hello")).toBe("hello");
    const masked = maskSecrets({ apiKey: "sk-1234", nested: { token: "ghp_abcdefghij" } }) as any;
    expect(masked.apiKey).toBe("[REDACTED]");
    expect(masked.nested.token).toBe("[REDACTED]");
  });

  it("tool_call redacts secret-shaped args even when allowed", async () => {
    const audits: unknown[] = [];
    const res = await tool_call({
      ctx: { workspaceRoot: "/tmp", actor: "t", audit: async (e) => { audits.push(e); } },
      name: "read_file",
      args: { path: "src/app.ts", apiKey: "sk-1234567890abc" },
    });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("sk-1234567890abc");
    expect(JSON.stringify(audits)).toContain("[REDACTED]");
  });

  it("sandbox escape refused and audited as denied", async () => {
    const audits: unknown[] = [];
    const res = await tool_call({
      ctx: { workspaceRoot: "/tmp", actor: "t", audit: async (e) => { audits.push(e); } },
      name: "read_file",
      args: { path: ".env" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("file-path-forbidden");
    expect(audits.length).toBeGreaterThan(0);
  });

  it("untrusted agent output cannot bypass tool scope", async () => {
    // Agent with no supportedTools is unrestricted only if empty array — documented.
    // Non-empty scope that doesn't contain requested tool → denied.
    const res = await tool_call({
      ctx: { workspaceRoot: "/tmp", actor: "t", audit: async () => {} },
      supportedTools: ["read_file"],
      name: "write_file",
      args: { path: "evil.txt" },
    });
    expect(res.ok).toBe(false);
  });

  it("routeCapability respects allowFallback:false (policy cannot be bypassed)", () => {
    const agents: AgentDefinition[] = [
      { _id: "a-fe", name: "FE", role: "frontend", capabilities: ["frontend-development"] },
    ];
    expect(routeCapability("security-audit", agents, { allowFallback: false })).toBeNull();
  });

  it("prompt payload never contains ciphertext-shaped secrets", async () => {
    const { buildTaskPrompt, buildChatPrompt } = await import("@/context/compaction");
    const taskPrompt = buildTaskPrompt({ assignment: "Do work", curatedContext: "some context" });
    const chatPrompt = buildChatPrompt({ history: [{ authorType: "user", content: "hi" }], summary: "earlier" });
    expect(taskPrompt).not.toContain("sk-");
    expect(chatPrompt).not.toContain("apiKey");
  });
});
