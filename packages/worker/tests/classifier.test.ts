import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/orchestrator/classifier";

describe("classifier", () => {
  it("treats greetings as direct conversation", () => {
    const result = classifyCommand("hello");
    expect(result.kind).toBe("conversation");
    expect(result.strategy).toBe("direct");
  });

  it("detects read-only audits", () => {
    const result = classifyCommand("audit the authentication flow for security issues");
    expect(result.kind).toBe("audit");
    expect(result.strategy).toBe("single");
  });

  it("detects questions without change verbs", () => {
    const result = classifyCommand("how does the approval flow work?");
    expect(result.kind).toBe("research");
  });

  it("detects multi-domain change requests", () => {
    const result = classifyCommand(
      "add a billing page in the frontend and create a new API endpoint on the backend"
    );
    expect(result.kind).toBe("multi");
    expect(result.strategy).toBe("dag");
    expect(result.suggestedCapabilities).toContain("frontend-development");
    expect(result.suggestedCapabilities).toContain("backend-development");
  });

  it("defaults change requests to focused implementation", () => {
    const result = classifyCommand("fix the button label in app/page.tsx");
    expect(result.kind).toBe("code_change");
    expect(result.strategy).toBe("single");
  });
});
