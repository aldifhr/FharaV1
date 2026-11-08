import { describe, expect, it } from "vitest";
import { classifyCommand } from "@/orchestrator/classifier";

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

  it("routes plain text/data file changes to backend, not frontend", () => {
    // Greetings of the plan-tone-check kind: a .txt file is not frontend
    // work and must not land on the Designer.
    const result = classifyCommand(
      "Create plan-tone-check.txt containing exactly one line: Plan tone check"
    );
    expect(result.kind).toBe("code_change");
    expect(result.suggestedCapabilities[0]).toBe("backend-development");
    expect(result.suggestedCapabilities).toContain("code-review");

    const notes = classifyCommand("Write sprint notes to notes.md");
    expect(notes.suggestedCapabilities[0]).toBe("backend-development");

    const data = classifyCommand("Create seed-data.json with two records");
    expect(data.suggestedCapabilities[0]).toBe("backend-development");
  });

  it("keeps frontend routing for code and design files", () => {
    const page = classifyCommand("Create structure-check-9d31.html with a heading");
    expect(page.suggestedCapabilities[0]).toBe("frontend-development");

    const script = classifyCommand("Add a timer to app.js");
    expect(script.suggestedCapabilities[0]).toBe("frontend-development");

    const ui = classifyCommand("redesign the pricing layout");
    expect(ui.suggestedCapabilities[0]).toBe("ui-ux-design");
  });

  it("does not let a data filename override explicit domain keywords", () => {
    const result = classifyCommand(
      "Create api/notes.md documenting the new endpoint"
    );
    expect(result.suggestedCapabilities[0]).toBe("backend-development");

    const frontend = classifyCommand(
      "Create frontend/notes.md describing the new component"
    );
    expect(frontend.suggestedCapabilities[0]).toBe("frontend-development");
  });
});
