"use client";
import DicebearAvatar from "./DicebearAvatar";
import { dicebearSeedFor, isDicebearAvatarParams } from "@/lib/dicebearAvatar";

type Props = {
  name: string;
  size?: number;
  status?: "idle" | "working" | "queued" | "needs_you" | "thinking" | "reviewing" | "waiting" | "blocked" | "completed" | "failed" | string;
  /** `{ dicebear: "lorelei", seed }`; anything else falls back to the name. */
  avatarParams?: unknown;
};

const STATUS_DOT: Record<string, string> = {
  working: "bg-emerald-500",
  thinking: "bg-emerald-500",
  reviewing: "bg-purple-500",
  waiting: "bg-amber-400",
  queued: "bg-amber-400",
  needs_you: "bg-rose-500",
  failed: "bg-rose-500",
  idle: "bg-gray-400",
};

/**
 * Agent avatar: the saved DiceBear seed when there is one, the name as the
 * seed otherwise (so every agent has a stable face without extra state).
 */
export default function AgentAvatar({ name, size = 32, status, avatarParams }: Props) {
  const seed = isDicebearAvatarParams(avatarParams) ? avatarParams.seed : dicebearSeedFor(name);

  return (
    <span
      className={`relative inline-flex shrink-0 transition-transform ${status === "working" ? "scale-110" : ""}`}
      style={{ width: size, height: size }}
    >
      <DicebearAvatar seed={seed} size={size} className="h-full w-full" />
      {status && (
        <>
          <span
            aria-hidden="true"
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-gray-900 ${STATUS_DOT[status] ?? "bg-gray-400"}`}
          />
          <span className="sr-only">{`${name}: ${String(status).replace(/_/g, " ")}`}</span>
        </>
      )}
    </span>
  );
}
