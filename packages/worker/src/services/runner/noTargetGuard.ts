import { requestText } from "@/orchestrator/classifier";

/** A fix / bug / investigation request (EN/ID). */
const FIX_REQUEST =
  /\b(?:fix|fixes|fixing|bugs?|bugfix|debug\w*|broken|perbaiki\w*|benerin|betulin|bug-?nya|masalah|kesalahan|error|errors|issues?|investigat\w*|investigasi)\b/i;

/**
 * No-target guard: a fix request whose prepared changes only CREATE files
 * and modify none. That usually means the agent built the feature the bug
 * was supposed to be in (live sandbox run: "search bug" in an app with no
 * search → src/app/search/page.tsx + src/components/search-form.tsx).
 * Returns the warning for the approval summary, or null.
 */
export function newFilesOnlyFixWarning(
  command: string,
  changes: ReadonlyArray<{ filePath: string; changeType: string }>
): string | null {
  if (changes.length === 0 || !FIX_REQUEST.test(requestText(command))) return null;
  if (!changes.every((change) => change.changeType === "new")) return null;
  const files = changes.map((change) => change.filePath);
  return `Check before approving: this is a fix request, but every change creates a new file (${files.slice(0, 5).join(", ")}${
    files.length > 5 ? ", …" : ""
  }) and none edits existing code. The feature or bug it refers to may not exist in the repository.`;
}
