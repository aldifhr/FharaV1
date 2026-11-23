import { describe, expect, it } from "vitest";
import { reasoningDelta } from "./llm";

describe("reasoningDelta", () => {
  it("does not double text sent in both reasoning fields", () => {
    expect(reasoningDelta({ reasoning_content: "Think.", reasoning: "Think." })).toBe("Think.");
  });
  it("falls back to reasoning, then nothing", () => {
    expect(reasoningDelta({ reasoning: "R" })).toBe("R");
    expect(reasoningDelta({ reasoning_content: "", reasoning: "R" })).toBe("R");
    expect(reasoningDelta({})).toBe("");
  });
});
