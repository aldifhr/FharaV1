/**
 * Pure helpers behind `useInspectorDraft` (dashboard F4). A draft is a flat
 * record of form values; values compare structurally so arrays and nested
 * records (skill ids, pins) count as unchanged when they hold the same data.
 */
export type Draft = Record<string, unknown>;

/** Structural equality for draft values (JSON data: primitives, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  // An undefined entry and a missing one are the same (pins cleared back to Latest).
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const key of keys) if (!sameValue(ra[key], rb[key])) return false;
  return true;
}

/** Keys whose draft value differs from the saved one, in the saved record's order. */
export function changedKeys<T extends Draft>(saved: T, draft: T): Array<keyof T> {
  const keys = new Set<keyof T>([...(Object.keys(saved) as Array<keyof T>), ...(Object.keys(draft) as Array<keyof T>)]);
  return [...keys].filter((key) => !sameValue(saved[key], draft[key]));
}

/** "Edited just now" / "Edited 3 min ago" for the inspector footer. */
export function editedLabel(editedAt: number | null, now: number): string | null {
  if (editedAt === null) return null;
  const seconds = Math.max(0, Math.round((now - editedAt) / 1000));
  if (seconds < 45) return "Edited just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Edited ${minutes} min ago`;
  return `Edited ${Math.round(minutes / 60)} h ago`;
}
