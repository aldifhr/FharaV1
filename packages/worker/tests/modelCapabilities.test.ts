import { describe, expect, it } from "vitest";
import {
  CALL_SITE_NEEDS,
  UNKNOWN_CAPABILITIES,
  builtinCapabilitiesFor,
  missingNeeds,
  resolveModelCapabilities,
  type CapabilityOverrideRow,
} from "@/api/convex/lib/modelCapabilities";
import { evaluateJsonProbe, evaluateToolProbe } from "@/api/convex/lib/capabilityProbe";
import { TaskLlmResolver, resolveForAgent, type ModelRoutingInfo, type PoolConnection, type PoolModel } from "@/llm/resolver";
import { capabilityLookupFrom } from "@/llm/resolver";
import { ProviderHealthRegistry } from "@/llm/health";

/** Plan 027: Model Capability Registry — resolution order, needs, fallback, markup tools. */

const model = (modelId: string, extra: Partial<PoolModel> = {}): PoolModel =>
  ({ _id: `row-${modelId}`, modelId, isAvailable: true, ...extra }) as PoolModel;
const conn = (partial: Partial<PoolConnection> & { _id: string; name: string }): PoolConnection =>
  ({ provider: "openai-compatible", baseUrl: "https://llm.example/v1", apiKeyEnv: "", apiKey: "k", priority: 10, weight: 100, models: [model("m1")], ...partial }) as PoolConnection;

describe("resolveModelCapabilities — resolution order", () => {
  const overrides: CapabilityOverrideRow[] = [
    { modelId: "gpt-4o", projectId: "p1", vision: false },
    { modelId: "gpt-4o", maxContextTokens: 64_000, vision: true, structuredOutput: false, probe: { at: 1, structuredOutput: true, toolCalling: "none" } },
  ];

  it("project override beats global override beats probe beats registry beats built-in", () => {
    const r = resolveModelCapabilities("gpt-4o", { overrides, projectId: "p1", registry: { contextWindow: 32_000, supportsTools: true } });
    expect(r.capabilities.vision).toBe(false);
    expect(r.sources.vision).toBe("project");
    expect(r.capabilities.maxContextTokens).toBe(64_000);
    expect(r.sources.maxContextTokens).toBe("global");
    // Global override (false) beats the probe (true).
    expect(r.capabilities.structuredOutput).toBe(false);
    expect(r.sources.structuredOutput).toBe("global");
    // Probe beats registry (supportsTools=true) and the built-in (native).
    expect(r.capabilities.toolCalling).toBe("none");
    expect(r.sources.toolCalling).toBe("probe");
    expect(r.capabilities.supportsStreaming).toBe(true);
    expect(r.sources.supportsStreaming).toBe("builtin");
  });

  it("another project's override does not apply", () => {
    const r = resolveModelCapabilities("gpt-4o", { overrides, projectId: "p2" });
    expect(r.capabilities.vision).toBe(true);
    expect(r.sources.vision).toBe("global");
  });

  it("registry fields apply between the probe and the built-ins; an unticked supportsTools is not evidence", () => {
    const r = resolveModelCapabilities("acme-1", { registry: { contextWindow: 50_000, supportsTools: false, inputPricePer1k: 0.1 } });
    expect(r.capabilities.maxContextTokens).toBe(50_000);
    expect(r.sources.maxContextTokens).toBe("registry");
    expect(r.capabilities.toolCalling).toBe("none");
    expect(r.sources.toolCalling).toBe("unknown");
    expect(r.capabilities.costPer1kIn).toBe(0.1);
  });

  it("unknown models get the conservative defaults", () => {
    const r = resolveModelCapabilities("totally-new-model");
    expect(r.capabilities).toEqual(UNKNOWN_CAPABILITIES);
    expect(Object.values(r.sources).every((s) => s === "unknown")).toBe(true);
  });

  it("built-ins match the id after a provider prefix", () => {
    expect(builtinCapabilitiesFor("openai/gpt-4o-mini")?.strengths).toContain("cheap");
    expect(builtinCapabilitiesFor("anthropic/claude-sonnet-4")?.toolCalling).toBe("native");
  });
});

describe("markup tool calling (nous / longcat)", () => {
  it("meituan/longcat-2.5 and the nous connection model resolve toolCalling=markup, not none", () => {
    for (const id of ["meituan/longcat-2.5", "nous"]) {
      const r = resolveModelCapabilities(id);
      expect(r.capabilities.toolCalling).toBe("markup");
      expect(r.capabilities.structuredOutput).toBe(true);
    }
  });

  it("markup satisfies a tool-calling need", () => {
    const caps = resolveModelCapabilities("meituan/longcat-2.5").capabilities;
    expect(missingNeeds(caps, { toolCalling: true })).toEqual([]);
    expect(missingNeeds({ ...caps, toolCalling: "none" }, { toolCalling: true })).toEqual(["toolCalling"]);
  });

  it("a ticked supportsTools on the registry row keeps the markup mode", () => {
    const r = resolveModelCapabilities("meituan/longcat-2.5", { registry: { supportsTools: true } });
    expect(r.capabilities.toolCalling).toBe("markup");
  });

  it("the probe recognizes <longcat_tool_call> text as markup", () => {
    const body = JSON.stringify({ choices: [{ message: { content: '<longcat_tool_call>{"name":"get_time","arguments":{"city":"Jakarta"}}</longcat_tool_call>' } }] });
    expect(evaluateToolProbe(body)).toBe("markup");
    expect(evaluateToolProbe(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "1" }] } }] }))).toBe("native");
    expect(evaluateToolProbe(JSON.stringify({ choices: [{ message: { content: "It is 3pm." } }] }))).toBe("none");
  });

  it("the JSON probe accepts fenced JSON and rejects prose", () => {
    expect(evaluateJsonProbe(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok": true, "n": 3}\n```' } }] }))).toBe(true);
    expect(evaluateJsonProbe(JSON.stringify({ choices: [{ message: { content: "Sure! ok" } }] }))).toBe(false);
    expect(evaluateJsonProbe(JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }] }))).toBe(true);
  });
});

describe("resolver needs filtering", () => {
  const lookup = capabilityLookupFrom([], undefined);
  const health = () => new ProviderHealthRegistry();

  it("skips the preferred model that lacks a need and picks the first that has it", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    const r = resolveForAgent(undefined, { capabilities: { structuredOutput: true }, callRole: "planner" }, pool, health(), { capabilityOf: lookup });
    expect(r.primary.model).toBe("gpt-4o");
    expect(r.routing.satisfied).toBe(true);
    expect(r.routing.fallback).toBe(false);
    expect(r.routing.skipped).toEqual([{ model: "totally-unknown", connection: "Alpha", missing: ["structuredOutput"] }]);
    expect(r.routing.reason).toMatch(/skipped totally-unknown/);
    // The skipped model stays in the chain (after the satisfying ones).
    expect(r.fallbackChain.map((h) => h.model)).toEqual(["totally-unknown"]);
  });

  it("the agent's assigned model wins when it satisfies the needs", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("gpt-4o")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("claude-sonnet-4")] }),
    ];
    const r = resolveForAgent({ llmProviderId: "b" }, { capabilities: { toolCalling: true } }, pool, health(), { capabilityOf: lookup });
    expect(r.primary.model).toBe("claude-sonnet-4");
  });

  it("filters on vision and context size", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("meituan/longcat-2.5")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    expect(resolveForAgent(undefined, { capabilities: { vision: true } }, pool, health(), { capabilityOf: lookup }).primary.model).toBe("gpt-4o");
    expect(resolveForAgent(undefined, { capabilities: { minContextTokens: 100_000 } }, pool, health(), { capabilityOf: lookup }).primary.model).toBe("meituan/longcat-2.5");
    // 150k fits neither (longcat 128k, gpt-4o 128k): usual pick + fallback flag.
    const tooBig = resolveForAgent(undefined, { capabilities: { minContextTokens: 150_000 } }, pool, health(), { capabilityOf: lookup });
    expect(tooBig.primary.model).toBe("meituan/longcat-2.5");
    expect(tooBig.routing.fallback).toBe(true);
  });

  it("falls back to the usual pick with a warning when nothing satisfies — never throws", () => {
    const pool = [conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] })];
    const warnings: ModelRoutingInfo[] = [];
    const resolver = new TaskLlmResolver(pool, health(), { onCapabilityFallback: (r) => warnings.push(r) });
    const handles = resolver.handlesFor(undefined, { capabilities: { structuredOutput: true }, callRole: "planner" });
    expect(handles[0].config.model).toBe("totally-unknown");
    resolver.handlesFor(undefined, { capabilities: { structuredOutput: true }, callRole: "planner" });
    expect(warnings).toHaveLength(1); // deduped per call role + model
    expect(warnings[0]).toMatchObject({ fallback: true, satisfied: false, missing: ["structuredOutput"], callRole: "planner" });
  });

  it("policy fixed never leaves the assignment for a capability", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    const r = resolveForAgent({ llmProviderId: "a", llmSelectionPolicy: "fixed" }, { capabilities: { structuredOutput: true } }, pool, health(), { capabilityOf: lookup });
    expect(r.primary.model).toBe("totally-unknown");
    expect(r.routing.fallback).toBe(true);
  });

  it("capability routing off records the needs but keeps the pool order", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    const r = resolveForAgent(undefined, { capabilities: { structuredOutput: true } }, pool, health(), { capabilityOf: lookup, capabilityRouting: false });
    expect(r.primary.model).toBe("totally-unknown");
    expect(r.routing.satisfied).toBe(false);
    expect(r.routing.fallback).toBe(false);
  });

  it("no needs leaves the pick exactly as before", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    const r = resolveForAgent(undefined, {}, pool, health(), { capabilityOf: lookup });
    expect(r.primary.model).toBe("totally-unknown");
    expect(r.routing.satisfied).toBe(true);
  });

  it("project overrides reach the resolver", () => {
    const pool = [
      conn({ _id: "a", name: "Alpha", priority: 1, models: [model("totally-unknown")] }),
      conn({ _id: "b", name: "Beta", priority: 5, models: [model("gpt-4o")] }),
    ];
    const resolver = new TaskLlmResolver(pool, health(), {
      capabilityOverrides: [{ modelId: "totally-unknown", projectId: "p1", structuredOutput: true }],
      projectId: "p1",
    });
    expect(resolver.resolutionFor(undefined, { capabilities: { structuredOutput: true } }).primary.model).toBe("totally-unknown");
  });
});

describe("call-site needs", () => {
  it("planner/decision need structured output; executor needs tools only when it uses them; visual QA needs vision", () => {
    expect(CALL_SITE_NEEDS.planner(4000)).toMatchObject({ structuredOutput: true });
    expect(CALL_SITE_NEEDS.decision(0).structuredOutput).toBe(true);
    expect(CALL_SITE_NEEDS.executor({ kind: "implementation", usesTools: true, visualQa: false, promptChars: 0 }).toolCalling).toBe(true);
    expect(CALL_SITE_NEEDS.executor({ kind: "review", usesTools: false, visualQa: true, promptChars: 0 }).vision).toBeUndefined();
    expect(CALL_SITE_NEEDS.executor({ kind: "qa", usesTools: false, visualQa: true, promptChars: 0 }).vision).toBe(true);
  });
});
