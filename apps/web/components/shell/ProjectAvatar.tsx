"use client";

import { pickByName } from "@/lib/utils";

const TONES = [
  "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15",
];

export function projectTone(name: string): string {
  return pickByName(name, TONES);
}

/** Coloured letter tile used for projects in the sidebar and chat header. */
export default function ProjectAvatar({ name, size = 22 }: { name: string; size?: number }) {
  const initial = (name.trim().charAt(0) || "•").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-semibold ${projectTone(name)}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), borderRadius: Math.round(size * 0.28) }}
    >
      {initial}
    </span>
  );
}
