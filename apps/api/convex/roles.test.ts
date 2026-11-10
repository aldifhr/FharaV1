import { describe, expect, it } from "vitest";
import { ROLES } from "./lib/roles";
import { AGENT_TOOL_NAMES } from "./lib/toolNames";

describe("role tool defaults (plan 036)", () => {
  it("gives the researcher the read-only web tool", () => {
    expect(ROLES.researcher.defaultTools).toContain("web_reach");
    expect(ROLES.researcher.defaultTools).toContain("read_file");
  });

  it("keeps the web tool out of the write-capable roles", () => {
    for (const key of ["frontend", "backend", "qa"] as const) {
      expect(ROLES[key].defaultTools).not.toContain("web_reach");
    }
  });

  it("offers only known tool names in the agent editor", () => {
    expect(AGENT_TOOL_NAMES).toContain("web_reach");
    for (const name of AGENT_TOOL_NAMES) {
      expect(["read_file", "write_file", "run_command", "web_reach"]).toContain(name);
    }
  });
});
