"use client";

import type { ReactNode } from "react";
import { Check, Loader2, Minus, X } from "lucide-react";
import InitialAvatar from "../../InitialAvatar";
import { roleLabel } from "@/lib/agentRoles";

/**
 * Plan 019 card language: white surface, soft border, rounded-xl, small
 * muted metadata, coloured status words. Dark mode is a neutral near-black
 * surface (not blue-grey) with white/10 hairlines.
 */
export const CARD_SURFACE =
  "overflow-hidden rounded-xl border border-[#e9e8ef] bg-white shadow-[0_1px_2px_rgba(30,25,60,.04)] dark:border-white/10 dark:bg-[#1c1c1f] dark:shadow-none";
export const CARD_DIVIDER = "border-[#efeef3] dark:border-white/[0.07]";
export const MUTED = "text-[#8a8796] dark:text-neutral-400";
export const TITLE = "text-[13px] font-semibold text-[#26242e] dark:text-neutral-100";

export const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[#635bff]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-[#1c1c1f]";
export const BTN_PRIMARY = `${BTN_BASE} bg-[#635bff] text-white shadow-sm hover:bg-[#5346d8]`;
export const BTN_OUTLINE = `${BTN_BASE} border border-[#e3e1ea] bg-white text-[#34323d] hover:bg-[#f7f6fa] dark:border-white/15 dark:bg-transparent dark:text-neutral-100 dark:hover:bg-white/5`;
export const BTN_TEXT = `${BTN_BASE} px-2.5 text-[#55525f] hover:text-[#26242e] dark:text-neutral-300 dark:hover:text-white`;

export type PillTone = "orange" | "blue" | "green" | "red" | "gray" | "indigo";

const PILL: Record<PillTone, string> = {
  orange: "bg-[#fff1e4] text-[#c2581a] dark:bg-orange-500/15 dark:text-orange-300",
  blue: "bg-[#eaf1ff] text-[#2f6fe0] dark:bg-blue-500/15 dark:text-blue-300",
  green: "bg-[#e9f8ef] text-[#1f8a4c] dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-[#fdecec] text-[#c43333] dark:bg-rose-500/15 dark:text-rose-300",
  gray: "bg-[#f2f1f5] text-[#6b6876] dark:bg-white/10 dark:text-neutral-300",
  indigo: "bg-[#eeedff] text-[#5148e0] dark:bg-indigo-500/20 dark:text-indigo-300",
};

export function Pill({ tone, children, className = "" }: { tone: PillTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] font-medium ${PILL[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** Small status chip with an icon, e.g. "✓ Approved", "no new packages". */
export function Chip({ tone = "gray", icon, children }: { tone?: PillTone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium ${PILL[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

export type StepStatus = "passed" | "failed" | "running" | "pending" | "not_run" | "blocked";

/** One status word with its icon; "not run" is grey, never green. */
export function StatusWord({ status, label, size = 14 }: { status: StepStatus; label?: string; size?: number }) {
  const text =
    label ??
    (status === "passed"
      ? "Passed"
      : status === "failed"
        ? "Failed"
        : status === "running"
          ? "Running"
          : status === "pending"
            ? "Queued"
            : status === "blocked"
              ? "Blocked"
              : "Not run");
  const icon =
    status === "passed" ? (
      <Check size={size} strokeWidth={2.5} className="text-[#1f9d55] dark:text-emerald-400" aria-hidden="true" />
    ) : status === "failed" ? (
      <X size={size} strokeWidth={2.5} className="text-[#d83a3a] dark:text-rose-400" aria-hidden="true" />
    ) : status === "running" ? (
      <Loader2 size={size} strokeWidth={2.5} className="animate-spin text-[#e5671f] dark:text-orange-400" aria-hidden="true" />
    ) : (
      <Minus size={size} strokeWidth={2.5} className="text-[#a3a0ad] dark:text-neutral-500" aria-hidden="true" />
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span
        className={
          status === "not_run" || status === "pending"
            ? "text-[#8a8796] dark:text-neutral-400"
            : "text-[#26242e] dark:text-neutral-100"
        }
      >
        {text}
      </span>
    </span>
  );
}

/** Coloured initial circle with role tint (C, F, D, Q…). */
export function RoleAvatar({ role, size = 20 }: { role?: string; size?: number }) {
  return <InitialAvatar name={roleLabel(role)} size={size} />;
}

export function CardHeader({
  icon,
  title,
  subtitle,
  pill,
  trailing,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  pill?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      {icon}
      <div className="min-w-0 flex-1">
        <p className={`${TITLE} break-words text-[14px]`}>{title}</p>
        {subtitle && <p className={`mt-0.5 text-[12px] ${MUTED}`}>{subtitle}</p>}
      </div>
      {pill}
      {trailing}
    </div>
  );
}

/** Rounded icon tile for a card header (↑ push, bell approval, …). */
export function IconTile({ children, tone = "orange" }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${PILL[tone]}`} aria-hidden="true">
      {children}
    </span>
  );
}

/**
 * One shell for every chat card (push, approval, option question, stage
 * results): optional agent line, header, body, action row.
 */
export function CardShell({
  agent,
  header,
  children,
  actions,
  className = "",
}: {
  agent?: { role?: string; label?: string } | null;
  header?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${CARD_SURFACE} ${className}`}>
      {agent && (
        <div className={`flex items-center gap-2 border-b px-4 py-2 text-[12px] ${CARD_DIVIDER} ${MUTED}`}>
          <RoleAvatar role={agent.role} size={18} />
          <span className="font-medium text-[#4c4a55] dark:text-neutral-200">{roleLabel(agent.role)}</span>
          {agent.label && <span>· {agent.label}</span>}
        </div>
      )}
      {header}
      {children}
      {actions && <div className={`flex flex-wrap items-center gap-2 border-t px-4 py-3 ${CARD_DIVIDER}`}>{actions}</div>}
    </div>
  );
}

export function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
