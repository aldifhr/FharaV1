import { describe, expect, test } from "vitest";
import { buildPlanningGuidance, CTO_ANALYSIS_GUIDANCE, isAnalysisSubtype } from "./chat";
import { ROLE_PROMPT_TEMPLATES } from "./rolePrompts.data";
import { ROLES } from "../roles";

const cto = { role: "cto" };
const smallProjectIntent = {
  kind: "chat",
  frontend: false,
  backend: false,
  testing: false,
  security: false,
  subtype: "research" as const,
};

describe("CTO reply modes", () => {
  test("a small-project analysis reads every file and is not capped at three sentences", () => {
    expect(isAnalysisSubtype("explanation")).toBe(true);
    expect(isAnalysisSubtype("research")).toBe(true);
    expect(isAnalysisSubtype("audit")).toBe(true);
    expect(isAnalysisSubtype("recommendation")).toBe(false);

    const analysis = buildPlanningGuidance(cto, {
      isOrchestrator: true,
      hasRepoTools: true,
      taskIntent: smallProjectIntent,
    }).join("\n");

    expect(analysis).toContain(CTO_ANALYSIS_GUIDANCE);
    for (const rule of [
      "package.json",
      "tsconfig",
      "bundler config",
      "entry points",
      "every file in the directory being analysed",
      "Never call a file unused, disconnected or missing unless you opened it",
      "say exactly which parts remain unread",
      "structure and data flow",
      "dependencies and versions read from the manifests",
      "connected and which are orphaned",
      "visible risks or bugs",
      "concrete next step",
      "no 2-3 sentence cap",
    ]) {
      expect(analysis, rule).toContain(rule);
    }
    expect(analysis).not.toContain("Answer briefly");
    expect(analysis).not.toContain("Keep your own replies short");

    const decision = buildPlanningGuidance(cto, {
      isOrchestrator: true,
      taskIntent: { ...smallProjectIntent, subtype: "recommendation" },
    }).join("\n");
    expect(decision).toContain("Answer briefly");

    const seed = ROLE_PROMPT_TEMPLATES.cto;
    expect(seed).toContain("Decision report");
    expect(seed).toContain("Analysis, explanation, audit or review");
    expect(seed).toContain("no sentence limit");
    expect(seed).toContain("every file in the directory being analysed");
    expect(ROLES.cto.hint).toContain("no sentence limit");
  });
});
