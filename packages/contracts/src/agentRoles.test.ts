import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { AgentRoleRefSchema } from "./agentRoles.ts";
import { CustomAgent } from "./settings.ts";

const decodeRef = Schema.decodeUnknownSync(AgentRoleRefSchema);
const decodeCustomAgent = Schema.decodeUnknownSync(CustomAgent);

describe("agent role refs", () => {
  it("accepts the fixed roles and custom agent ids", () => {
    expect(decodeRef("frontend")).toBe("frontend");
    expect(decodeRef("custom:docs-writer")).toBe("custom:docs-writer");
  });

  it("rejects malformed agent ids", () => {
    expect(() => decodeRef("janitor")).toThrow();
    expect(() => decodeRef("custom:")).toThrow();
    expect(() => decodeRef("Custom:docs")).toThrow();
    expect(() => decodeRef("custom:docs writer")).toThrow();
  });
});

describe("custom agents setting", () => {
  it("decodes an agent with name, instructions and optional model", () => {
    expect(
      decodeCustomAgent({
        id: "custom:docs-writer",
        name: "Docs writer",
        instructions: "You maintain the documentation.",
      }),
    ).toEqual({
      id: "custom:docs-writer",
      name: "Docs writer",
      instructions: "You maintain the documentation.",
    });
    expect(
      decodeCustomAgent({
        id: "custom:strict-reviewer",
        name: "Strict reviewer",
        role: "reviewer",
        instructions: "",
      }).role,
    ).toBe("reviewer");
  });

  it("rejects empty names and unknown id shapes", () => {
    expect(() =>
      decodeCustomAgent({ id: "custom:docs-writer", name: "  ", instructions: "" }),
    ).toThrow();
    expect(() =>
      decodeCustomAgent({ id: "docs-writer", name: "Docs", instructions: "" }),
    ).toThrow();
  });
});
