import { describe, expect, it } from "vitest";
import {
  AGENT_REACH_CHANNEL_NAMES,
  AGENT_REACH_MAX_LIMIT,
  AGENT_REACH_MAX_QUERY_CHARS,
  buildAgentReachArgs,
  formatAgentReachResult,
  runAgentReach,
  type AgentReachResult,
} from "@/tools/agentReach";

describe("Agent Reach argv allowlist", () => {
  it("builds an exact argv for an allowlisted channel and action", () => {
    const built = buildAgentReachArgs({ channel: "web", action: "search", query: "convex typescript", limit: 3 });
    expect(built).toEqual({ ok: true, args: ["web", "search", "convex typescript", "--limit", "3"] });
  });

  it("accepts an action without an argument", () => {
    const built = buildAgentReachArgs({ channel: "v2ex", action: "hot", limit: 5 });
    expect(built).toEqual({ ok: true, args: ["v2ex", "hot", "--limit", "5"] });
  });

  it("refuses a channel outside the public allowlist", () => {
    const built = buildAgentReachArgs({ channel: "twitter", action: "search", query: "convex" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toMatch(/not allowed/);
  });

  it("refuses an action the channel does not offer", () => {
    const built = buildAgentReachArgs({ channel: "web", action: "post", query: "hello" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toMatch(/not allowed/);
  });

  it("refuses an argument that would be read as a flag", () => {
    const built = buildAgentReachArgs({ channel: "web", action: "search", query: "--backend" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toMatch(/may not start with/);
  });

  it("refuses control characters and oversized arguments", () => {
    expect(buildAgentReachArgs({ channel: "web", action: "search", query: "a\nb" }).ok).toBe(false);
    expect(
      buildAgentReachArgs({ channel: "web", action: "search", query: "x".repeat(AGENT_REACH_MAX_QUERY_CHARS + 1) }).ok
    ).toBe(false);
    expect(
      buildAgentReachArgs({ channel: "web", action: "search", query: "x".repeat(AGENT_REACH_MAX_QUERY_CHARS) }).ok
    ).toBe(true);
  });

  it("refuses a private, loopback or metadata URL", () => {
    for (const url of [
      "http://127.0.0.1:3000/admin",
      "http://localhost/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://192.168.1.10/secret",
    ]) {
      const built = buildAgentReachArgs({ channel: "web", action: "read", query: url });
      expect(built.ok, url).toBe(false);
    }
  });

  it("accepts a public URL", () => {
    const built = buildAgentReachArgs({ channel: "web", action: "read", query: "https://example.com/post" });
    expect(built).toEqual({ ok: true, args: ["web", "read", "https://example.com/post"] });
  });

  it("refuses a limit outside the range or on an action without one", () => {
    expect(buildAgentReachArgs({ channel: "web", action: "search", query: "x", limit: 0 }).ok).toBe(false);
    expect(buildAgentReachArgs({ channel: "web", action: "search", query: "x", limit: AGENT_REACH_MAX_LIMIT + 1 }).ok).toBe(false);
    expect(buildAgentReachArgs({ channel: "web", action: "search", query: "x", limit: AGENT_REACH_MAX_LIMIT }).ok).toBe(true);
    expect(buildAgentReachArgs({ channel: "web", action: "search", query: "x", limit: 1.5 }).ok).toBe(false);
    const noLimit = buildAgentReachArgs({ channel: "web", action: "read", query: "https://example.com", limit: 5 });
    expect(noLimit.ok).toBe(false);
  });

  it("only exposes public channels", () => {
    expect(AGENT_REACH_CHANNEL_NAMES.sort()).toEqual(["bilibili", "github", "v2ex", "web", "youtube"]);
  });
});

describe("Agent Reach result handling", () => {
  it("reports a missing binary instead of throwing", async () => {
    const result = await runAgentReach(
      { channel: "web", action: "search", query: "convex" },
      { command: "agent-reach-does-not-exist" }
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_INSTALLED");
    expect(result.items).toEqual([]);
  });

  it("reports a refused request instead of spawning anything", async () => {
    const result = await runAgentReach({ channel: "twitter", action: "search", query: "convex" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("BAD_INPUT");
    expect(result.local).toBe(true);
  });

  it("formats the items and the failure for the model", () => {
    const ok: AgentReachResult = {
      ok: true,
      items: [{ title: "Hello", url: "https://example.com", text: "Body" }],
    };
    const text = formatAgentReachResult(ok);
    expect(text).toContain("Hello");
    expect(text).toContain("https://example.com");

    const failed = formatAgentReachResult({
      ok: false,
      items: [],
      errorCode: "RATE_LIMITED",
      errorMessage: "slow down",
      hint: "wait",
    });
    expect(failed).toContain("RATE_LIMITED");
    expect(failed).toContain("slow down");
    expect(failed).toContain("wait");
  });
});
