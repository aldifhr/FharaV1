// Adapted from threadbear (https://github.com/mikecann/threadbear), runner/src/diff.ts @ 43fa197.
// MIT License, Copyright (c) 2026 Mike Cann. See THIRD_PARTY_NOTICES.md.
//
// Changes: the Hunk type from protocol.ts is inlined; nothing else.
/** One unified-diff hunk (threadbear protocol.ts `Hunk`). */
export type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

type Op = { tag: ' ' | '-' | '+'; text: string };

export function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  // A trailing newline ends the last line rather than starting a new one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Line diff with unified-style hunks (3 lines of context), the same shape the
// Claude CLI uses for its structuredPatch. Trims the common head and tail
// first, so the LCS only runs over the part that changed; a huge middle falls
// back to "replace all of it" rather than burning CPU.
export function diffLines(before: string, after: string, context = 3): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);
  return buildHunks(ops, context);
}

function diffOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ tag: ' ', text: a[i] });
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length * bm.length > 4_000_000) {
    for (const t of am) ops.push({ tag: '-', text: t });
    for (const t of bm) ops.push({ tag: '+', text: t });
  } else {
    ops.push(...lcsOps(am, bm));
  }
  for (let i = a.length - tail; i < a.length; i++) ops.push({ tag: ' ', text: a[i] });
  return ops;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ tag: '+' as const, text }));
  if (m === 0) return a.map((text) => ({ tag: '-' as const, text }));
  // dp[i][j] = LCS length of a[i..] and b[j..], flattened.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ tag: '-', text: a[i++] });
    } else {
      ops.push({ tag: '+', text: b[j++] });
    }
  }
  while (i < n) ops.push({ tag: '-', text: a[i++] });
  while (j < m) ops.push({ tag: '+', text: b[j++] });
  return ops;
}

function buildHunks(ops: Op[], context: number): Hunk[] {
  const changeIdx: number[] = [];
  ops.forEach((op, i) => {
    if (op.tag !== ' ') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];
  // Group changes whose context windows touch.
  const groups: [number, number][] = [];
  let start = changeIdx[0];
  let end = changeIdx[0];
  for (const i of changeIdx.slice(1)) {
    if (i - end <= context * 2 + 1) end = i;
    else {
      groups.push([start, end]);
      start = end = i;
    }
  }
  groups.push([start, end]);

  // Line numbers before each op.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(n);
    if (op.tag !== '+') o++;
    if (op.tag !== '-') n++;
  }

  return groups.map(([s, e]) => {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((x) => x.tag !== '+').length;
    const newLines = slice.filter((x) => x.tag !== '-').length;
    return {
      // Unified diff convention: a zero-length side starts at the line before.
      oldStart: oldLines === 0 ? oldNo[from] - 1 : oldNo[from],
      oldLines,
      newStart: newLines === 0 ? newNo[from] - 1 : newNo[from],
      newLines,
      lines: slice.map((x) => x.tag + x.text),
    };
  });
}

// Applies an Edit/MultiEdit style string replacement. Returns null when the
// old text isn't there.
export function applyReplace(content: string, oldString: string, newString: string, replaceAll: boolean): string | null {
  if (oldString === '') return null;
  const at = content.indexOf(oldString);
  if (at < 0) return null;
  if (replaceAll) return content.split(oldString).join(newString);
  return content.slice(0, at) + newString + content.slice(at + oldString.length);
}
