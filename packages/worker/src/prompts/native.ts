/** Short message passed verbatim on the provider CLI argv; the full prompt
 *  travels via an attached file (`-f`) so argv stays well under the Windows
 *  limit (~32k) regardless of audit/repository context size. Message first,
 *  `-f` after: `--file` is an [array] and swallows the positional message
 *  when it comes first (`File not found: <first word>` on opencode 1.x). */
export const NATIVE_PROMPT_MESSAGE =
  "Read the attached prompt file and execute the instructions in it. The attached file sits in a temporary folder that is NOT the workspace: work only in the current working directory, using relative paths. When done, write a short summary: what you changed, files touched, and anything that needs follow-up.";

/** Header pinning the workspace for the model: without it, models tend to
 *  treat the attached prompt file's temp folder as the project (seen in the
 *  live smoke run) and every write there is denied as external. */
export function workspaceHeader(workspacePath: string): string {
  return [
    `Workspace (your current working directory): ${workspacePath}`,
    "All reads and writes must stay inside this directory; paths outside it are denied.",
    "",
  ].join("\n");
}

export function buildNativePrompt(input: {
  title: string;
  description: string;
  command: string;
  systemPrompt?: string;
  priorContext?: string;
  fileContext?: string;
}): string {
  return [
    input.systemPrompt ? `Role: ${input.systemPrompt}` : "",
    `Task: ${input.command}`,
    `Your part: ${input.title} — ${input.description}`,
    input.priorContext ? `\nPrior context:\n${input.priorContext}` : "",
    input.fileContext ? `\nWorkspace context:\n${input.fileContext}` : "",
    "",
    "You have full workspace access (the current working directory is the task workspace). Make the changes yourself; do not ask for approval.",
    "Only touch files inside the current working directory; use relative paths. Do not commit or push.",
    "When done, write a short summary: what you changed, files touched, and anything that needs follow-up.",
  ]
    .filter(Boolean)
    .join("\n");
}
