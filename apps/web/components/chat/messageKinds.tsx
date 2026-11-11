/** Message kinds and the checked-files line, split out of MessageList.tsx (line budget). */
export type MessageKind = "evaluation" | "planning" | "delegation" | "design" | null;

export function messageKindOf(content: string): MessageKind {
  return /^Task (completed|finished)/.test(content) ? "evaluation" :
    /^Plan dibuat/.test(content) ? "planning" :
    /^Delegation:/.test(content) ? "delegation" :
    /^Design proposal:/.test(content) ? "design" : null;
}

export function delegationParts(content: string) {
  const match = content.match(/^Delegation:\s*(.+?)\s*→\s*(.+?)\s*\((.+?)\)(?::\s*(.*))?$/s);
  return match ? { from: match[1], to: match[2], capability: match[3], reason: match[4] ?? "" } : null;
}

/** Files the agent read while writing a grounded reply: one quiet line under the bubble. */
const CHECKED_FILES_SHOWN = 6;
export function checkedFilesLabel(files: string[]): string {
  const shown = files.slice(0, CHECKED_FILES_SHOWN).join(", ");
  const more = files.length - CHECKED_FILES_SHOWN;
  return `Checked: ${shown}${more > 0 ? ` +${more} more` : ""}`;
}

export function CheckedFilesLine({ files }: { files: string[] }) {
  return (
    <p className="mt-1 max-w-3xl truncate pl-1 text-[12px] text-ink-3" title={files.join("\n")}>
      {checkedFilesLabel(files)}
    </p>
  );
}
