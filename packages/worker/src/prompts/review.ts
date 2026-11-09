/** The review prompt: frozen change-set diff + the strict review JSON schema. */
export function buildReviewPrompt(input: {
  command: string;
  scope: string;
  snapshotId: string;
  diffText: string;
}): string {
  const { snapshotId, diffText } = input;
  return [
    `Review these prepared changes for: ${input.command}`,
    `Review scope: ${input.scope}`,
    `Change-set snapshot id: ${snapshotId}. Review exactly this frozen set.`,
    diffText,
    "",
    "Return JSON only:",
    '{"verdict":"approved"|"changes_requested","findings":[{"severity":"critical"|"high"|"medium"|"low","filePath":"...","description":"...","suggestion":"..."}]}',
    "Reject only for concrete correctness, security, or regression risks. Do not request style-only changes.",
    "You cannot call tools: the diff above is everything. Do not emit tool calls.",
  ].join("\n");
}

/** One retry after an unparseable review, showing the model its own answer. */
export function reviewRetryPrompt(reviewPrompt: string, previous: string): string {
  return `${reviewPrompt}\n\nYour previous answer was not the review JSON object. Return ONLY {"verdict":...,"findings":[...]} now.\n\nPrevious answer (for reference):\n${previous}`;
}
