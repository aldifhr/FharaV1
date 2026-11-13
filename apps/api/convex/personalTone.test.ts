/**
 * Personal chat tone: a personal chat with no project is for brainstorming,
 * technical discussion, learning and general help. Seen in the app: asked
 * "kamu cuma bisa convex?", the Backend agent recited its boundaries ("bukan
 * UI, bukan menggantikan role lain"), said "saya belum cek repo kamu sama
 * sekali" and pushed "attach project-nya". The project prompt and the
 * attached personal chat keep the repo grounding rule.
 */
import { describe, expect, test } from "vitest";
import {
  buildChatPersonaLines,
  buildGroundingGuidance,
  buildPersonalChatSystem,
  buildPersonalModeSection,
  buildPlanningGuidance,
  isSeedPersonaPrompt,
} from "./lib/prompts/chat";
import { AGENT_SEED_PROMPTS } from "./lib/prompts/agents";
import { ROLES, ROLE_KEYS, roleChatSummary } from "./lib/roles";

const backend = { name: "Backend", role: "Backend", systemPrompt: AGENT_SEED_PROMPTS.backend };

/** The personal-path system prompt as chat.ts assembles it (no tools). */
function personalSystem(agent: typeof backend, projectName: string | null, repoSnapshot: string | null = null): string {
  return [
    ...buildPersonalChatSystem(agent, { projectName, repoSnapshot, repoTools: false }),
    ...(projectName ? buildGroundingGuidance(false) : []),
  ].join("\n");
}

describe("personal chat with no project", () => {
  const system = personalSystem(backend, null);

  test("answers broadly: personal-mode section, stack-neutral area, user's language", () => {
    expect(system).toContain("## Personal chat");
    expect(system).toContain("brainstorming, technical discussion, learning, questions and general help");
    expect(system).toContain("APIs, business logic, databases, auth, data validation");
    expect(system).toContain("any language, framework or stack");
    expect(system).toContain("in the user's language");
  });

  test("no grounding rule and no 'haven't checked' / attach nag by default", () => {
    expect(system).not.toContain("Grounding rule");
    expect(system).not.toContain("belum saya cek");
    expect(system).not.toContain("I haven't checked");
    expect(system).not.toContain("If the user asks for work on code, say they can attach a project");
    // Attach is mentioned only as the conditional answer to a question about their own code.
    expect(system).toMatch(/Do not mention the repo, attaching a project, or that you have not checked anything, unless the user asks about their own code/);
  });

  test("no boundary recital: the unedited seed persona (Convex, 'Boundaries: no UI work') is left out", () => {
    expect(system).not.toContain("Convex");
    expect(system).not.toContain("Boundaries:");
    expect(system).not.toContain("no UI work");
    expect(system).toContain("Never recite your scope, boundaries or what you are not, unless the user asks what you can't do.");
    expect(system).toContain("limit what you DO in tasks (writing code, running commands), not what you can talk about");
  });

  test("a persona the user edited is kept", () => {
    const edited = { ...backend, systemPrompt: "You are my Go backend mentor. Prefer Postgres." };
    expect(personalSystem(edited, null)).toContain("You are my Go backend mentor");
  });

  test("teammate suggestion is one short line, no @mention pull-in", () => {
    expect(system).toContain("name that role (without @) in one short line");
    expect(system).not.toContain("Never hand the question to a teammate");
  });

  test("no tools: never a tool call; with the skill tool that line is left to the skill protocol", () => {
    expect(buildPersonalModeSection(backend)).toContain("never output a tool call or JSON");
    expect(buildPersonalModeSection(backend, { skillTool: true })).not.toContain("never output a tool call");
  });
});

describe("attached personal chat", () => {
  test("keeps the repo grounding rule and the persona, no personal-mode section", () => {
    const system = personalSystem(backend, "Fhara", "apps/\npackages/");
    expect(system).toContain('attached to project "Fhara"');
    expect(system).toContain("Grounding rule");
    expect(system).toContain("never what they contain");
    expect(system).toContain(AGENT_SEED_PROMPTS.backend);
    expect(system).not.toContain("## Personal chat");
  });
});

describe("project chat prompt is unchanged", () => {
  test("Backend, no tools", () => {
    const system = [
      ...buildChatPersonaLines(backend, "Fhara", [], "apps/\npackages/", false),
      ...buildPlanningGuidance(backend, {
        isOrchestrator: false,
        hasRepoTools: false,
        taskIntent: { kind: "ask", frontend: false, backend: true, testing: false, security: false },
      }),
      ...buildGroundingGuidance(false),
    ]
      .filter(Boolean)
      .join("\n");
    expect(system).not.toContain("## Personal chat");
    expect(system).toContain(AGENT_SEED_PROMPTS.backend);
    expect(system).toMatchSnapshot();
  });
});

describe("roles", () => {
  test("every role has a stack-neutral chat summary; the worker hint is untouched", () => {
    for (const key of ROLE_KEYS) {
      expect(ROLES[key].chatSummary.length).toBeGreaterThan(10);
      expect(ROLES[key].chatSummary).not.toMatch(/convex/i);
    }
    expect(roleChatSummary("Backend")).toBe(ROLES.backend.chatSummary);
    expect(roleChatSummary("backend")).toBe(ROLES.backend.chatSummary);
    expect(roleChatSummary("Security")).toBeNull();
    expect(ROLES.backend.hint).toContain("Convex functions, schema, validation");
  });

  test("seed detection", () => {
    expect(isSeedPersonaPrompt("Backend", AGENT_SEED_PROMPTS.backend)).toBe(true);
    expect(isSeedPersonaPrompt("Backend", "custom")).toBe(false);
    expect(isSeedPersonaPrompt("Backend", undefined)).toBe(false);
  });
});
