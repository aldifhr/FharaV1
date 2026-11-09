/**
 * Single source of truth for "does this request want visual QA?".
 * A negated prohibition anywhere in the request wins over the positive
 * signal, which is what makes "@QA must not run screenshots/viewports"
 * authoritative rather than advisory.
 */
export function wantsVisualQa(command: string): boolean {
  const prohibited =
    /\b(?:no|not|without|don't|do\s+not|jangan|tanpa)\b[\s\S]{0,160}\b(?:visual|screenshots?|baselines?|pixels?|responsive|viewports?|desktop|tablet|mobile)\b/i.test(
      command
    );
  if (prohibited) return false;
  return /\b(?:visual\s+regression|screenshots?|baselines?|pixel(?:-diff)?|responsive\s+(?:layout|viewports?)|(?:desktop|tablet|mobile)\s+(?:and\s+\w+\s+)?viewports?|viewport\s+testing)\b/i.test(
    command
  );
}
