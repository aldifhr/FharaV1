/**
 * Stop for a chat reply in flight (composer Stop button).
 *
 * The reply runs in a Convex action, which nothing outside can signal, so
 * the stop is a durable flag: `chatReplies.stopReply` settles the user
 * message as `replyStatus: "stopped"` and freezes its bubbles. The running
 * action polls that flag while an LLM call is in flight (watchReplyStop)
 * and aborts its own fetch through the signal bound to its ctx
 * (bindReplyStop / replyStopOf).
 * The mutations a late run would still make (new bubbles, patches, task
 * offers) refuse a stopped reply on the server, so a run that is between
 * LLM calls when the flag lands writes nothing either.
 */

/** How often a running reply re-reads its stop flag. */
export const REPLY_STOP_POLL_MS = 750;

/** Thrown into the reply run once the user pressed Stop; never shown as a failure. */
export class ChatStoppedError extends Error {
  constructor() {
    super("Reply stopped by the user");
    this.name = "ChatStoppedError";
  }
}

export function isChatStopped(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof ChatStoppedError || signal?.aborted === true;
}

/** True once the run that holds `runId` should stop: the user stopped it, or another run took the message. */
export function replyStopRequested(
  message: { replyStatus?: string; replyRunId?: string } | null,
  runId: string
): boolean {
  if (!message) return true;
  return message.replyStatus === "stopped" || (message.replyRunId !== undefined && message.replyRunId !== runId);
}

/**
 * The reply run's stop flag. `during(call)` polls `isStopped` every
 * `everyMs` while an LLM call is in flight and aborts the returned signal
 * once it says true; no timer runs between calls (a reply can wait on a
 * repo tool or a mutation, and an idle interval would keep firing until
 * the action ends). `check()` reads the flag once. One read at a time;
 * dispose() clears the timer and waits for a read still in flight (no
 * dangling query after the action returns).
 */
export type ReplyStopWatch = {
  signal: AbortSignal;
  check: () => Promise<boolean>;
  during: <T>(call: () => Promise<T>) => Promise<T>;
  dispose: () => Promise<void>;
};

export function watchReplyStop(isStopped: () => Promise<boolean>, everyMs = REPLY_STOP_POLL_MS): ReplyStopWatch {
  const controller = new AbortController();
  let inflight: Promise<boolean> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = 0;
  const check = (): Promise<boolean> => {
    if (controller.signal.aborted) return Promise.resolve(true);
    if (inflight) return inflight;
    inflight = isStopped()
      .then((stopped) => {
        if (stopped && !controller.signal.aborted) controller.abort(new ChatStoppedError());
        return stopped;
      })
      .catch(() => false)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    check,
    during: async (call) => {
      active += 1;
      if (!timer) {
        timer = setInterval(() => void check(), everyMs);
        (timer as { unref?: () => void }).unref?.();
      }
      try {
        return await call();
      } finally {
        active -= 1;
        if (active === 0) stopTimer();
      }
    },
    dispose: async () => {
      stopTimer();
      if (inflight) await inflight;
    },
  };
}

// The reply action passes its ctx down to every chat LLM call
// (completeWithSnapshot), so the stop signal rides on the ctx object
// instead of a new parameter through every helper.
const watches = new WeakMap<object, ReplyStopWatch>();

export function bindReplyStop(ctx: object, watch: ReplyStopWatch): void {
  watches.set(ctx, watch);
}

export function replyStopOf(ctx: object): ReplyStopWatch | undefined {
  return watches.get(ctx);
}
