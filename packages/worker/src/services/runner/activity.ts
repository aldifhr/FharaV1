/**
 * Live "what is the agent doing" line for a running subtask. The worker
 * turns executor events into one short sentence and stores it on the
 * subtask row (subtasks.activity), which the task panel shows under the
 * running row. Pure so it can be unit tested.
 */

const MAX = 120;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ACTIVITY_STARTING = "Starting";
export const ACTIVITY_THINKING = "Waiting for the model";

/** Activity text for an executor event, or null when it says nothing new. */
export function describeActivity(type: string, payload: unknown): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
  switch (type) {
    case "agent.context": {
      if (p.retry) return "Model answer was invalid, retrying";
      if (p.repaired) return "Repairing the model answer";
      if (Array.isArray(p.readPaths) && p.readPaths.length > 0) {
        return clip(`Reading ${count(p.readPaths.length, "file")}: ${p.readPaths.slice(0, 3).join(", ")}`);
      }
      if (p.mode === "shell (allowlisted)") return "Preparing a command";
      if ("filesHinted" in p) return "Reading the repository";
      return null;
    }
    case "shell.command": {
      const cmd = [p.command, ...(Array.isArray(p.args) ? p.args : [])].filter(Boolean).join(" ");
      return cmd ? clip(`Running ${cmd}`) : "Running a command";
    }
    case "command.waiting_approval": {
      const cmd = [p.command, ...(Array.isArray(p.args) ? p.args : [])].filter(Boolean).join(" ");
      return clip(`Waiting for approval: ${cmd || "a command"}`);
    }
    case "options.waiting":
      return clip(`Waiting for your pick: ${typeof p.title === "string" ? p.title : "options"}`);
    case "task.check":
      return p.label ? clip(`Checking ${p.label}${p.status && p.status !== "running" ? `: ${p.status}` : ""}`) : null;
    case "agent.web_context":
      return "Reading web docs";
    case "agent.mcp_tools":
      return typeof p.toolCalls === "number" && p.toolCalls > 0
        ? `Used ${count(p.toolCalls, "MCP tool call")}`
        : "Checking MCP tools";
    case "native.context":
      return "Working in the coding agent (OpenCode)";
    case "review.completed":
      return "Review finished";
    case "file.staged":
      return p.filePath ? clip(`Writing ${p.filePath}`) : null;
    default:
      return null;
  }
}

/**
 * Coalesces activity writes per subtask: skips repeats and never lets a
 * failed write surface (activity is cosmetic and must not fail the run).
 */
export function createActivityReporter(write: (activity: string) => Promise<unknown>) {
  let last: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return (activity: string | null) => {
    if (!activity || activity === last) return;
    last = activity;
    chain = chain.then(() => write(activity)).catch(() => undefined);
  };
}
