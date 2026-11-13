"use client";

import type { ReactNode } from "react";
import { Check, Loader2, Minus, X } from "lucide-react";
import InitialAvatar from "../../InitialAvatar";
import type { StatusTone } from "../../ui/status-tag";
import { roleLabel } from "@/lib/agentRoles";

/**
 * Plan 019 card language: white surface, soft border, rounded-xl, small
 * muted metadata, status as StatusTag (dashboard F3). Dark mode is a neutral near-black
 * surface (not blue-grey) with white/10 hairlines.
 */
export const CARD_SURFACE =
  "overflow-hidden rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(30,25,60,.04)] dark:shadow-none";
export const CARD_DIVIDER = "border-line";
export const MUTED = "text-ink-3";
const TITLE = "text-[13px] font-semibold text-ink";

const BTN_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_PRIMARY = `${BTN_BASE} bg-ink text-canvas shadow-sm hover:bg-ink/85`;
export const BTN_OUTLINE = `${BTN_BASE} border border-line bg-panel text-ink hover:bg-hover dark:bg-transparent`;
export const BTN_TEXT = `${BTN_BASE} px-2.5 text-ink-2 hover:text-ink`;

/** Status tones come from the shared StatusTag (hairline frame + text, no tinted fill). */
export type { StatusTone } from "../../ui/status-tag";

const TILE_TONE: Record<StatusTone, string> = {
  neutral: "text-ink-2",
  active: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
};

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
      <Check size={size} strokeWidth={2.5} className="text-ok" aria-hidden="true" />
    ) : status === "failed" ? (
      <X size={size} strokeWidth={2.5} className="text-danger" aria-hidden="true" />
    ) : status === "running" ? (
      <Loader2 size={size} strokeWidth={2.5} className="animate-spin text-warn" aria-hidden="true" />
    ) : (
      <Minus size={size} strokeWidth={2.5} className="text-ink-3" aria-hidden="true" />
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span
        className={
          status === "not_run" || status === "pending"
            ? "text-ink-3"
            : "text-ink"
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

/** Inset icon tile for a card header (↑ push, bell approval, …). */
export function IconTile({ children, tone = "warn" }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-field bg-inset ${TILE_TONE[tone]}`} aria-hidden="true">
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
          <span className="font-medium text-ink-2">{roleLabel(agent.role)}</span>
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
