// Adapted from GOAT (https://github.com/goat-si/goat) apps/server/src/checkpointing/Diffs.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
//
// Changed by Fhara (GOAT G5): `toSorted` became a sort on a copy (the worker
// targets ES2022). Otherwise verbatim.

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Parses `git diff --numstat -z` output; a rename record carries the old and new path as two extra fields. */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    let previousPath: string | undefined;
    if (path.length === 0) {
      previousPath = records[index + 1];
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export function isGitImport(
  file: TurnDiffFileSummary,
  authoredPaths: ReadonlySet<string> | null,
): boolean {
  return (
    authoredPaths !== null &&
    !authoredPaths.has(file.path) &&
    (file.previousPath === undefined || !authoredPaths.has(file.previousPath))
  );
}
