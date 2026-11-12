import type { LibrarySkillRef, PromptSkill } from "@/api/convex/lib/skills";
/** Agent definitions as the worker routes and executes them. */

export interface AgentDefinition {
  _id: string;
  name: string;
  role: string;
  systemPrompt?: string;
  description?: string;
  capabilities?: string[];
  skills?: string[];
  supportedTools?: string[];
  isEnabled?: boolean;
  priority?: number;
  maxConcurrency?: number;
  status?: string;
  // LLM assignment (Phase 2 resolver): optional per-agent provider/model
  // preference + fallback + selection policy, independent of identity/role.
  llmProviderId?: string;
  llmModelId?: string;
  llmFallbackProviderId?: string;
  llmFallbackModelId?: string;
  llmSelectionPolicy?: "fixed" | "priority" | "weighted" | "round_robin";
  // Execution runtime override: "api" (host tools + gated LLM) or
  // "opencode" (OpenCode CLI with native tools in the task worktree).
  // Unset = global ORCHESTRATOR_EXECUTION_RUNTIME default.
  executionRuntime?: "api" | "opencode";
  /** Optional OpenCode model (`provider/model`); unset = Fhara's own LLM. */
  opencodeModel?: string;
  /**
   * Skill v2: set only when the agent's skillLoading is "on_demand". The
   * system prompt then holds just the skills index; the executor offers the
   * read-only load_skill tool over these (execution/skillLoading.ts).
   * Never widens supportedTools.
   */
  onDemandSkills?: PromptSkill[];
  /** Shared library skills this agent may load (no bodies; load_skill fetches one). */
  librarySkills?: LibrarySkillRef[];
}

export type AgentStatus = "idle" | "working" | "queued" | "needs_you";
