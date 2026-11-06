"use client";
import { AvatartionAvatarView, avatartionFor, deserializeAvatartion, type AvatartionAvatar } from "./ui/avatartion";
import type { AvatarParams } from "../lib/avatar";

type Props = {
  name: string;
  size?: number;
  status?: "idle" | "working" | "queued" | "needs_you";
  avatar?: AvatartionAvatar;
  avatarParams?: AvatarParams;
};

const STATUS_DOT: Record<string, string> = {
  working: "bg-emerald-500",
  idle: "bg-gray-400",
  queued: "bg-amber-400",
  needs_you: "bg-rose-500",
};

export default function AgentAvatar({ name, size = 32, status, avatar, avatarParams }: Props) {
  const restored = avatarParams ? deserializeAvatartion(avatarParams) : null;
  const resolvedAvatar = avatar ?? restored ?? avatartionFor(name);

  return (
    <span
      className={`relative inline-flex shrink-0 transition-transform ${status === "working" ? "scale-110" : ""}`}
      style={{ width: size, height: size }}
    >
      <AvatartionAvatarView avatar={resolvedAvatar} className="h-full w-full" />
      {status && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${STATUS_DOT[status] ?? "bg-gray-400"}`}
        />
      )}
    </span>
  );
}
