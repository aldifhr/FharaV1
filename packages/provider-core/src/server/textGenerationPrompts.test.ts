import { describe, expect, it } from "vitest";

import { AGENT_ROLE_IDS } from "@fhara/contracts";

import { buildOrchestrationPlanPrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildOrchestrationPlanPrompt", () => {
  it("catalogs every registered role and the request", () => {
    const { prompt } = buildOrchestrationPlanPrompt({
      prompt: "Add an orchestrator playground",
      projectTitle: "Fhara",
    });
    for (const roleId of AGENT_ROLE_IDS) {
      expect(prompt).toContain(`- ${roleId}`);
    }
    expect(prompt).toContain("Add an orchestrator playground");
    expect(prompt).toContain("Project context: Fhara");
  });

  it("requires approval gates for high-risk steps and forbids invented roles", () => {
    const { prompt } = buildOrchestrationPlanPrompt({ prompt: "deploy it" });
    expect(prompt).toContain("Never invent roles");
    expect(prompt).toContain("requiresApproval");
    expect(prompt).toMatch(/Approval gates cannot be bypassed/);
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the project to leave out of initial and regenerated titles", () => {
    for (const previousTitle of [undefined, "Hyperdrive Config Crash"]) {
      const { prompt } = buildThreadTitlePrompt({
        message: "hyperdrive init crashes without a config",
        previousTitle,
        projectTitle: "Hyperdrive",
      });
      expect(prompt).toContain('Never include the project name ("Hyperdrive")');
    }
  });
});
