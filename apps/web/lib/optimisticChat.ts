/**
 * Optimistic chat send (t3code idea #2, idea only): the user's bubble shows
 * the moment they press Send, keyed by a client message id, and is replaced
 * by the server row carrying the same `clientId` once the mutation commits.
 */

const OPTIMISTIC_PREFIX = "optimistic:";

export type SendArgs = {
  /** Absent in a personal chat (plan 039): its rows carry no project. */
  projectId?: string;
  content: string;
  conversationId?: string;
  quotedMessageId?: string;
  clientId?: string;
};

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** The placeholder row drawn before the server answers. */
export function optimisticUserRow(args: SendArgs & { clientId: string }, now: number) {
  return {
    _id: `${OPTIMISTIC_PREFIX}${args.clientId}`,
    _creationTime: now,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    authorType: "user" as const,
    content: args.content.trim(),
    clientId: args.clientId,
    replyStatus: "pending" as const,
    optimistic: true as const,
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    ...(args.quotedMessageId ? { quotedMessageId: args.quotedMessageId } : {}),
  };
}

export function isOptimistic(row: { _id?: unknown }): boolean {
  return typeof row._id === "string" && row._id.startsWith(OPTIMISTIC_PREFIX);
}

/**
 * Append a placeholder to a message list unless a row with this clientId is
 * already there (a retried send must not draw a second bubble).
 */
export function withOptimisticRow<T extends { clientId?: unknown }>(rows: T[], row: T & { clientId: string }): T[] {
  if (rows.some((r) => r.clientId === row.clientId)) return rows;
  return [...rows, row];
}

/** Drop placeholders whose server row (same clientId) has arrived. */
export function reconcileOptimistic<T extends { _id?: unknown; clientId?: unknown }>(rows: T[]): T[] {
  const confirmed = new Set<unknown>();
  for (const r of rows) if (!isOptimistic(r) && r.clientId) confirmed.add(r.clientId);
  return rows.filter((r) => !isOptimistic(r) || !confirmed.has(r.clientId));
}
