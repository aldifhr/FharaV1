/** Severity of a task event (task timeline). */
export type EventLevel = "info" | "warn" | "error";

/** Event sink handed to executors: one timeline event per call. */
export type EventSink = (
  type: string,
  payload: Record<string, unknown>,
  level?: EventLevel
) => Promise<void>;
