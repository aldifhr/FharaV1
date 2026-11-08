"use client";

/**
 * Compact initial avatar matching the workspace design language: a pastel
 * circle with the agent's initial and an optional status dot.
 */
const ROLE_BG: Record<string, string> = {
  L: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  C: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  D: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
  F: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  B: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  Q: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  G: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  S: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
};

const COLORS = [
  "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
];

const DOT: Record<string, string> = {
  working: "bg-emerald-500",
  idle: "bg-gray-300 dark:bg-gray-600",
  queued: "bg-amber-400",
  needs_you: "bg-orange-500",
  reviewing: "bg-blue-500",
  testing: "bg-teal-500",
  waiting: "bg-orange-500",
};

export function colorForName(name: string): string {
  const initial = (name.trim().charAt(0) || "•").toUpperCase();
  if (ROLE_BG[initial]) return ROLE_BG[initial];
  return COLORS[[...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % COLORS.length];
}

export default function InitialAvatar({
  name,
  size = 28,
  status,
}: {
  name: string;
  size?: number;
  status?: "idle" | "working" | "queued" | "needs_you" | "reviewing" | "testing" | "waiting" | string;
}) {
  const initial = (name.trim().charAt(0) || "•").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full font-bold ${colorForName(name)}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial}
      {status && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-gray-900 ${DOT[status] ?? "bg-gray-400"}`}
        />
      )}
    </span>
  );
}
