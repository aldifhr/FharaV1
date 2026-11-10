/**
 * O5: tamper-evident audit chain.
 *
 * Every new `audit` row carries `seq` (1, 2, 3 …), `prevHash` (the previous
 * chained row's `hash`, "" for the first) and
 * `hash = sha256(prevHash + "\n" + canonical(row))`. Editing a row breaks
 * its own hash; deleting one breaks the next row's `prevHash` link (and
 * leaves a gap in `seq`). Rows written before the chain existed have no
 * hash and are reported as "pre-chain", never as broken.
 *
 * Pure apart from Web Crypto (available in Convex's runtime and Node).
 */

/** Fields covered by the hash: everything but Convex's own and the chain fields. */
const EXCLUDED = new Set(["_id", "_creationTime", "hash", "prevHash"]);

/** Deterministic JSON: object keys sorted at every level, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The canonical string of a row (chain fields and Convex system fields excluded). */
export function canonicalAuditRow(row: Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!EXCLUDED.has(key)) body[key] = value;
  return canonicalJson(body);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function auditRowHash(prevHash: string, row: Record<string, unknown>): Promise<string> {
  return await sha256Hex(`${prevHash}\n${canonicalAuditRow(row)}`);
}

export type ChainRow = Record<string, unknown> & { seq?: number; hash?: string; prevHash?: string };

export interface ChainVerdict {
  ok: boolean;
  /** Rows with a hash that were checked. */
  checked: number;
  /** Rows without a hash (written before the chain). */
  preChain: number;
  /** `seq` of the first row that does not verify. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify rows in ascending `seq` order (pre-chain rows may be mixed in and
 * are counted, not checked). `fromStart`: the window is the whole chain, so
 * it must begin at seq 1. Otherwise the first chained row may link to a row
 * outside the window (`startPrevHash` when known).
 */
export async function verifyAuditChain(
  rows: readonly ChainRow[],
  opts: { startPrevHash?: string; fromStart?: boolean; tombstones?: ReadonlyMap<number, string> } = {}
): Promise<ChainVerdict> {
  const { startPrevHash } = opts;
  const tombstones = opts.tombstones ?? auditTombstones(rows);
  // Seqs [from, to) all deleted through the audit page (recorded), so the gap is accounted for.
  const accounted = (from: number, to: number) => {
    for (let s = from; s < to; s++) if (!tombstones.has(s)) return false;
    return true;
  };
  let preChain = 0;
  let checked = 0;
  let prev: { seq: number; hash: string } | null = null;
  for (const row of rows) {
    if (typeof row.hash !== "string" || typeof row.seq !== "number") {
      preChain += 1;
      continue;
    }
    if (!prev && opts.fromStart && row.seq !== 1 && !accounted(1, row.seq)) {
      return { ok: false, checked, preChain, brokenAt: row.seq, reason: `rows before ${row.seq} are missing` };
    }
    if (prev && row.seq !== prev.seq + 1 && !accounted(prev.seq + 1, row.seq)) {
      return { ok: false, checked, preChain, brokenAt: row.seq, reason: `row ${prev.seq + 1} is missing` };
    }
    const gapHash = tombstones.get(row.seq - 1);
    const expectedPrev =
      prev && row.seq === prev.seq + 1
        ? prev.hash
        : gapHash !== undefined && (prev || opts.fromStart)
          ? gapHash
          : prev
            ? prev.hash
            : startPrevHash ?? (row.seq === 1 ? "" : row.prevHash ?? "");
    if ((row.prevHash ?? "") !== expectedPrev) {
      return { ok: false, checked, preChain, brokenAt: row.seq, reason: "link to the previous row does not match" };
    }
    const hash = await auditRowHash(row.prevHash ?? "", row);
    if (hash !== row.hash) return { ok: false, checked, preChain, brokenAt: row.seq, reason: "row content changed" };
    checked += 1;
    prev = { seq: row.seq, hash: row.hash };
  }
  return { ok: true, checked, preChain };
}

/** Action of the row the audit page writes when it deletes chained rows. */
export const AUDIT_DELETE_ACTION = "audit.delete";

/** seq → hash of chained rows deleted through the audit page (from its `audit.delete` rows). */
export function auditTombstones(rows: readonly ChainRow[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const row of rows) {
    if (row.action !== AUDIT_DELETE_ACTION) continue;
    const deleted = (row.details as { deleted?: unknown } | undefined)?.deleted;
    if (!Array.isArray(deleted)) continue;
    for (const d of deleted) {
      const e = d as { seq?: unknown; hash?: unknown };
      if (typeof e.seq === "number" && typeof e.hash === "string") out.set(e.seq, e.hash);
    }
  }
  return out;
}
