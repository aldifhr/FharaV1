"use client";
import { useState } from "react";
import { avatarUrl, fallbackColor, initials, type AvatarParams } from "../lib/avatar";

type Props = {
  name: string;
  size?: number;
  status?: "idle" | "working" | "queued" | "needs_you";
  avatarParams?: AvatarParams;
};

const STATUS_DOT: Record<string, string> = {
  working: "bg-emerald-500",
  idle: "bg-gray-400",
  queued: "bg-amber-400",
  needs_you: "bg-rose-500",
};

export default function AgentAvatar({ name, size = 32, status, avatarParams }: Props) {
  const [err, setErr] = useState(false);
  const showImg = avatarParams && !err;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl(avatarParams as AvatarParams)}
          alt={name}
          width={size}
          height={size}
          className="rounded-full object-cover"
          onError={() => setErr(true)}
        />
      ) : (
        <span
          className={`inline-flex items-center justify-center rounded-full text-white font-semibold ${fallbackColor(name)}`}
          style={{ width: size, height: size, fontSize: size * 0.4 }}
          aria-label={name}
        >
          {initials(name)}
        </span>
      )}
      {status && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${STATUS_DOT[status] ?? "bg-gray-400"}`}
        />
      )}
    </span>
  );
}

