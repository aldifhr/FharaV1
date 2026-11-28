import { describe, expect, it } from "vitest";
import { CAPABILITY, type AgentDefinition } from "@/types";
import {
  discoverCapabilities,
  discoverCapability,
  reportOutcome,
  type CapabilityProbe,
} from "@/utils/capabilityDiscovery";

function probe(extra: Partial<CapabilityProbe> = {}): CapabilityProbe {
  return {
    workspaceMounted: true,
    shell: "available",
    browser: "available",
    nativeRuntime: "available",
    webReach: "unknown",
    ...extra,
  };
}

function agent(role: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return { _id: `a-${role}`, name: role, role, isEnabled: true, ...extra };
}

describe("capability discovery reflects the runtime", () => {
  it("a writer with a mounted workspace can write; without one it cannot", () => {
    expect(discoverCapability(CAPABILITY.FRONTEND, agent("frontend"), probe()).status).toBe("available");
    expect(
      discoverCapability(CAPABILITY.FRONTEND, agent("frontend"), probe({ workspaceMounted: false })).status
    ).toBe("unavailable");
  });

  it("a read-only role never reports a write capability available", () => {
    for (const role of ["cto", "qa", "designer", "lead"]) {
      const state = discoverCapability(CAPABILITY.FRONTEND, agent(role), probe());
      expect(state.status, role).toBe("unavailable");
      expect(state.reason, role).toMatch(/may not write/);
    }
  });

  it("shell work follows the role policy and the machine", () => {
    expect(discoverCapability(CAPABILITY.SHELL_EXECUTION, agent("cto"), probe()).status).toBe("unavailable");
    expect(discoverCapability(CAPABILITY.SHELL_EXECUTION, agent("qa"), probe()).status).toBe("unavailable");
    expect(discoverCapability("test-run", agent("qa"), probe()).status).toBe("available");
    expect(discoverCapability(CAPABILITY.SHELL_EXECUTION, agent("backend"), probe()).status).toBe("available");
    expect(
      discoverCapability(CAPABILITY.SHELL_EXECUTION, agent("backend"), probe({ shell: "unavailable" })).status
    ).toBe("unavailable");
    expect(
      discoverCapability(CAPABILITY.SHELL_EXECUTION, agent("backend"), probe({ shell: "unknown" })).status
    ).toBe("unknown");
  });

  it("browser QA is unavailable without Chromium and unknown before the probe", () => {
    expect(
      discoverCapability(CAPABILITY.BROWSER_TESTING, agent("qa"), probe({ browser: "unavailable" })).status
    ).toBe("unavailable");
    expect(
      discoverCapability(CAPABILITY.BROWSER_TESTING, agent("qa"), probe({ browser: "unknown" })).status
    ).toBe("unknown");
    expect(discoverCapability(CAPABILITY.BROWSER_TESTING, agent("qa"), probe()).status).toBe("available");
  });

  it("an unbound capability is unknown, never available", () => {
    const state = discoverCapability("database-tuning", agent("backend"), probe());
    expect(state.status).toBe("unknown");
  });

  it("web work needs a web tool before the probe is consulted", () => {
    expect(discoverCapability(CAPABILITY.WEB_BROWSING, agent("cto"), probe()).status).toBe("unavailable");
    expect(
      discoverCapability(
        CAPABILITY.WEB_BROWSING,
        agent("backend", { supportedTools: ["web_reach"] }),
        probe({ webReach: "available" })
      ).status
    ).toBe("available");
  });

  it("reports every declared capability and a worst-case outcome", () => {
    const states = discoverCapabilities(agent("qa"), probe({ browser: "unavailable" }));
    expect(states.map((state) => state.capability)).toContain("browser-testing");
    expect(reportOutcome(states)).toBe("unavailable");
    expect(reportOutcome(discoverCapabilities(agent("frontend"), probe()))).toBe("available");
  });
});
