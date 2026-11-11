import { describe, expect, test } from "vitest";
import { REASONING_DISPLAY_MAX_CHARS, isPromptEchoLine, reasoningForDisplay } from "./reasoningDisplay";
import { firstReasoningSentence } from "./activity";

describe("reasoningForDisplay", () => {
  test("drops lines that echo the system prompt and the tool protocol", () => {
    const raw = [
      "The user wants bold.html with Hello World.",
      "My system prompt says I'm a lazy senior developer.",
      "I can make at most 6 tool calls.",
      "I must reply with ONLY one JSON object to call a tool.",
      "The grounding rule says to cite only tool results.",
      "Plan: a single HTML file with a <style> block.",
    ].join("\n");
    const out = reasoningForDisplay(raw);
    expect(out).toContain("The user wants bold.html");
    expect(out).toContain("Plan: a single HTML file");
    expect(out).not.toMatch(/system prompt|lazy senior|tool calls|JSON object|grounding rule/i);
  });
  test("drops repeated lines and caps the length", () => {
    const dup = "Plan: header, list, detail.\nPlan: header, list, detail.\nPlan: header, list, detail.";
    expect(reasoningForDisplay(dup)).toBe("Plan: header, list, detail.");
    const long = Array.from({ length: 200 }, (_, i) => `Design note ${i}: spacing and layout for the board view.`).join("\n");
    const out = reasoningForDisplay(long);
    expect(out.length).toBeLessThanOrEqual(REASONING_DISPLAY_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });
  test("ordinary design reasoning is kept", () => {
    expect(isPromptEchoLine("Personas: a team lead and an individual contributor.")).toBe(false);
    expect(isPromptEchoLine("Per my instructions I should read the tokens first.")).toBe(true);
  });
  test("the activity intent line never takes a prompt-echo sentence", () => {
    expect(firstReasoningSentence("My system prompt says to be brief. Then read tokens.", "design a task app")).toBeNull();
  });
});
