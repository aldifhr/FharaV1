import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { auditRowHash } from "./auditHash";

/** An `audit` row as callers write it (the chain fields are added here). */
export type AuditInsert = Omit<Doc<"audit">, "_id" | "_creationTime" | "seq" | "prevHash" | "hash">;

/**
 * O5: the one way to insert an `audit` row. Reads the newest chained row
 * (by_seq) and links the new one to it. Convex mutations are serializable,
 * so two concurrent inserts conflict on that read and one retries: the
 * chain never forks.
 */
export async function insertAudit(ctx: MutationCtx, row: AuditInsert) {
  const last = await ctx.db.query("audit").withIndex("by_seq").order("desc").first();
  const lastSeq = typeof last?.seq === "number" ? last.seq : 0;
  const prevHash = lastSeq > 0 && typeof last?.hash === "string" ? last.hash : "";
  const seq = lastSeq + 1;
  const hash = await auditRowHash(prevHash, { ...row, seq });
  return await ctx.db.insert("audit", { ...row, seq, prevHash, hash });
}
