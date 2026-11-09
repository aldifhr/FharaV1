import { allowedCommandLines } from "@/utils/commandAllowlist";

/** The exact JSON reply the shell agent must give (the strict output contract). */
export const SHELL_JSON_SCHEMA =
  '{"command":"<binary>","args":["<arg>", ...]}';

/** The refusal shape, for a request no allowlisted command can serve. */
export const SHELL_REFUSAL_SCHEMA = '{"command":null,"reason":"<one line>"}';

/**
 * The allowlisted shell commands, as shown to the shell agent. Generated from
 * the same allowlist `tools/runCommand.ts` enforces, so the prompt can never
 * list fewer (or more) commands than the executor accepts.
 */
export function shellRegistryList(): string {
  return ["Allowlisted commands (exact argv, nothing appended):", ...allowedCommandLines().map((line) => `- ${line}`)].join("\n");
}

/** Instruction for the allowlisted shell agent (single JSON argv reply). */
export function shellInstruction(): string {
  return [
    "You choose ONE allowlisted command for the worker to run. You do not run it yourself.",
    "Reply with a single-line JSON object and nothing else (no prose, no code fence):",
    SHELL_JSON_SCHEMA,
    'Example: "run the tests" -> {"command":"npm","args":["run","test"]}',
    "",
    shellRegistryList(),
    "",
    "Rules:",
    "- Pick the allowlisted command that does what the task asks; prefer the narrowest variant.",
    "- args must equal one allowlisted line exactly: no extra flags, paths, pipes or redirects.",
    "- If no allowlisted command can serve the task (file creation / write /",
    "  printf / redirect, or any other binary), do NOT invent argv and do NOT",
    "  delegate to shell-execution (that is yourself, a loop). Reply instead with",
    `  ${SHELL_REFUSAL_SCHEMA}`,
    "  and the orchestrator will replan.",
  ].join("\n");
}

/** User content of the shell call. */
export function shellUserContent(instruction: string, command: string): string {
  return `${instruction}\n\nTask: ${command}`;
}

/**
 * One-shot repair: the previous reply was not the JSON contract. Re-asks with
 * the exact schema and the allowlist; the reply is parsed once more and the
 * subtask fails if it is still not valid.
 */
export function shellRepairContent(previousReply: string): string {
  const shown = previousReply.trim().slice(0, 500) || "(empty)";
  return [
    "Your previous reply was not valid. It must be exactly one JSON object and nothing else.",
    `Previous reply: ${shown}`,
    "",
    `Schema: ${SHELL_JSON_SCHEMA}`,
    `If no allowlisted command fits: ${SHELL_REFUSAL_SCHEMA}`,
    "",
    shellRegistryList(),
    "",
    "Reply now with the JSON object only.",
  ].join("\n");
}

export type ShellReply =
  | { kind: "command"; command: string; args: string[] }
  | { kind: "refusal"; reason: string };

/**
 * Parse the shell agent's reply against the contract. A code fence around the
 * object is tolerated; anything else that is not the schema is null (invalid
 * reply, the caller repairs once and then fails). `{"command":null,...}` is an
 * explicit refusal, never retried.
 */
export function parseShellReply(content: string): ShellReply | null {
  const normalized = content.replace(/```(?:json)?/gi, "").trim();
  const match = normalized.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: { command?: unknown; args?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.command === null) {
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "no allowlisted command fits the task";
    return { kind: "refusal", reason: reason.slice(0, 500) };
  }
  const command = typeof parsed.command === "string" ? parsed.command.trim() : "";
  if (!command || !Array.isArray(parsed.args)) return null;
  if (!parsed.args.every((arg) => typeof arg === "string")) return null;
  return { kind: "command", command, args: (parsed.args as string[]).map((arg) => arg.trim()) };
}
