/**
 * Line diff for Self-Improvement Lab suggestions: a unified diff of the
 * current text of a prompt / skill / role config against the proposed
 * version. Pure (no runtime APIs), shared with the web app.
 */

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

const MAX_LINES = 3_000;

/** LCS line diff. Inputs past MAX_LINES lines fall back to replace-all. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  }
  // Trim the common prefix / suffix first; prompts usually change in one place.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ op: " ", text: midA[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      mid.push({ op: "-", text: midA[i] });
      i += 1;
    } else {
      mid.push({ op: "+", text: midB[j] });
      j += 1;
    }
  }
  while (i < n) mid.push({ op: "-", text: midA[i++] });
  while (j < m) mid.push({ op: "+", text: midB[j++] });
  return [
    ...a.slice(0, start).map((text) => ({ op: " " as const, text })),
    ...mid,
    ...a.slice(endA).map((text) => ({ op: " " as const, text })),
  ];
}

/** Unified diff text (`@@ -l,n +l,n @@` hunks, `context` lines around changes). "" when equal. */
export function unifiedDiff(before: string, after: string, label = "text", context = 3): string {
  if (before === after) return "";
  const lines = diffLines(before, after);
  const changed = lines.map((line, index) => (line.op !== " " ? index : -1)).filter((index) => index >= 0);
  if (changed.length === 0) return "";
  // Group changed indexes into hunks with `context` lines around them.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  // Line numbers in each file at each position.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let nNo = 1;
  for (const line of lines) {
    oldNo.push(o);
    newNo.push(nNo);
    if (line.op !== "+") o += 1;
    if (line.op !== "-") nNo += 1;
  }
  for (const [from, to] of hunks) {
    const slice = lines.slice(from, to + 1);
    const oldCount = slice.filter((line) => line.op !== "+").length;
    const newCount = slice.filter((line) => line.op !== "-").length;
    out.push(`@@ -${oldCount ? oldNo[from] : oldNo[from] - 1},${oldCount} +${newCount ? newNo[from] : newNo[from] - 1},${newCount} @@`);
    for (const line of slice) out.push(`${line.op}${line.text}`);
  }
  return out.join("\n");
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}
