import { describe, expect, it } from "vitest";
import {
  capabilityForRole,
  capabilitiesOf,
  normalizeCapability,
} from "@/utils/agentCapabilities";
import {
  ROLES,
  roleChatSummary,
  roleKeyForMention,
  rolePermissionsFor,
} from "@/api/functions/lib/roles";

describe("capability resolution uses the shared role registry", () => {
  it("every fixed role maps to its registry capabilities, by key and by title", () => {
    for (const key of ["cto", "lead", "frontend", "backend", "devops", "qa", "designer"] as const) {
      expect(capabilityForRole(key)).toEqual([...ROLES[key].registryCapabilities]);
    }
    expect(capabilityForRole("Frontend Developer")).toEqual([...ROLES.frontend.registryCapabilities]);
    expect(capabilityForRole("UI/UX Designer")).toEqual([...ROLES.designer.registryCapabilities]);
  });

  it("spaced and titled aliases resolve like the backend (no second regex table)", () => {
    expect(capabilityForRole("Dev Ops")).toEqual([...ROLES.devops.registryCapabilities]);
    expect(capabilityForRole("Dev Ops Engineer")).toEqual([...ROLES.devops.registryCapabilities]);
    expect(roleKeyForMention("@Dev Ops")).toBe("devops");
    expect(rolePermissionsFor("Dev Ops")?.shell).toBe("allowlist");
    expect(roleChatSummary("Dev Ops")).toBe(ROLES.devops.chatSummary);
  });

  it("worker-only heuristics match whole tokens for non-role agents", () => {
    expect(capabilityForRole("Security Auditor")).toContain("security-audit");
    expect(capabilityForRole("GitHub Bot")).toContain("github");
    expect(capabilityForRole("Shell Runner")).toContain("shell-execution");
    expect(capabilityForRole("Juggler")).toEqual(["juggler", "general"]);
  });

  it("declared capabilities win over the role heuristic", () => {
    expect(
      capabilitiesOf({ _id: "x", name: "X", role: "cto", capabilities: ["frontend-development"] })
    ).toEqual(["frontend-development"]);
  });

  it("normalizes whitespace without a regular expression", () => {
    expect(normalizeCapability("  Frontend   Development ")).toBe("frontend-development");
  });
});
