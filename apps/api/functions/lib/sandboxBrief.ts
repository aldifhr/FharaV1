/**
 * The Sandbox brief (written by the retired Sandbox page) wraps the
 * user's instruction: a header line, "Instruction: <the user's words>",
 * then a "Guardrails:" line and a closing line about the worktree. Only the
 * instruction is the request: classification, requirement extraction and
 * requirement quotes must read it, never the wrapper (live tests 3/4:
 * "jalankan tes" in the brief was classified code_change from the
 * wrapper's own words, and the guardrail lines became requirements).
 */

const ATTACHED_CONTEXT = /\n\s*(?:---\s*Conversation context\s*---|Attached file context:|---\s*File:)/i;
const SANDBOX_BRIEF = /^\s*Sandbox experiment "[^\n]*\n\s*Instruction:[ \t]*([\s\S]*?)\n\s*Guardrails:/i;

/** Where the user's instruction sits inside a Sandbox brief, or null for any other command. */
export function sandboxInstructionSpan(command: string): { start: number; end: number } | null {
  const match = SANDBOX_BRIEF.exec(command);
  if (!match || match[1] === undefined) return null;
  const raw = match[1];
  const instruction = raw.trim();
  if (!instruction) return null;
  // Locate the captured group: it ends right before the newline that
  // precedes "Guardrails:".
  const groupStart = match[0].indexOf(raw, match[0].indexOf("Instruction:"));
  const start = (match.index ?? 0) + groupStart + (raw.length - raw.trimStart().length);
  return { start, end: start + instruction.length };
}

/**
 * The user's own instruction inside a Sandbox brief, with anything appended
 * after the brief (attached file contexts, conversation context) kept. Any
 * other command is returned unchanged.
 */
export function unwrapSandboxBrief(command: string): string {
  const match = SANDBOX_BRIEF.exec(command);
  const span = sandboxInstructionSpan(command);
  if (!match || !span) return command;
  const instruction = command.slice(span.start, span.end);
  const rest = command.slice((match.index ?? 0) + match[0].length);
  const attached = ATTACHED_CONTEXT.exec(rest);
  return attached ? `${instruction}${rest.slice(attached.index)}` : instruction;
}
