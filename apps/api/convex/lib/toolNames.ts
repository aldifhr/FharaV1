/**
 * The governed host tools an agent can be granted (plan 036).
 *
 * The names are the ones the worker's governance registry and the
 * Agent Reach web tool use. An agent only gets a tool when its
 * `supportedTools` list contains the name — the worker's tool scope is
 * never widened on the agent's behalf.
 *
 * Pure TS: imported by the web app (`@/api/convex/lib/toolNames`).
 */

export interface AgentToolOption {
  name: string;
  label: string;
  hint: string;
}

export const AGENT_TOOL_OPTIONS: readonly AgentToolOption[] = [
  {
    name: "read_file",
    label: "Read files",
    hint: "Read a file inside the workspace (sandbox-checked).",
  },
  {
    name: "write_file",
    label: "Write files",
    hint: "Stage a write inside the workspace (still needs the approval gate).",
  },
  {
    name: "run_command",
    label: "Run commands",
    hint: "Run an exact-allowlisted command (still needs the approval gate).",
  },
  {
    name: "web_reach",
    label: "Web research",
    hint: "Read public web content through Agent Reach (read-only, public channels only).",
  },
];

export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOL_OPTIONS.map((option) => option.name);
