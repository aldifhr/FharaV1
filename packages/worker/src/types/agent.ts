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
  llmSelectionPolicy?: "fixed" | "priority" | "weighted";
  // Execution runtime override: "api" (host tools + gated LLM) or
  // "opencode" (OpenCode CLI with native tools in the task worktree).
  // Unset = global ORCHESTRATOR_EXECUTION_RUNTIME default.
  executionRuntime?: "api" | "opencode";
  /** Optional OpenCode model (`provider/model`); unset = MOAgent's own LLM. */
  opencodeModel?: string;
}

export type AgentStatus = "idle" | "working" | "queued" | "needs_you";
