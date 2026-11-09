/**
 * UI-only shared types. Domain shapes that the backend owns come from
 * `@/api/convex/_generated/dataModel` or `@/api/convex/lib/...`.
 */

/** The minimal agent shape components need to label and colour a member. */
export type AgentRef = { _id: string; role: string; avatarParams?: unknown };
