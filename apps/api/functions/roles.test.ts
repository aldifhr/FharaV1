import { describe, expect, it } from "vitest";
import { ROLES } from "./lib/roles";
import { AGENT_TOOL_NAMES } from "./lib/toolNames";

describe("role tool defaults (plan 036)", () => {
  it("keeps writes scoped to implementation roles and DevOps infrastructure paths", () => {
    expect(ROLES.cto.defaultTools).not.toContain("write_file");
    expect(ROLES.qa.defaultTools).not.toContain("web_reach");
    expect(ROLES.designer.defaultTools).not.toContain("write_file");
    expect(ROLES.designer.permissions.options).toBe(true);
    for (const key of ["frontend", "backend"] as const) {
      expect(ROLES[key].defaultTools).toContain("write_file");
      expect(ROLES[key].defaultTools).not.toContain("web_reach");
    }
    expect(ROLES.devops.defaultTools).toContain("write_file");
    expect(ROLES.devops.permissions.write).toEqual([".github/**", "Dockerfile*", "docker-compose*", "infra/**"]);
    expect(ROLES.devops.permissions.push).toBe(false);
  });

  it("offers only known tool names in the agent editor", () => {
    expect(AGENT_TOOL_NAMES).toContain("web_reach");
    for (const name of AGENT_TOOL_NAMES) {
      expect(["read_file", "write_file", "run_command", "web_reach"]).toContain(name);
    }
  });
});
