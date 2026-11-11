import type { ReactNode } from "react";

/**
 * Status as a hairline frame plus text (dashboard restyle F1). No tinted fill,
 * no rounded-full: the tone only changes the border and the text colour, and
 * every colour is a theme token from app/globals.css.
 */
export type StatusTone = "neutral" | "active" | "ok" | "warn" | "danger";

const TONE: Record<StatusTone, string> = {
  neutral: "",
  active: "[--status-tone:var(--color-ink)]",
  ok: "[--status-tone:var(--color-ok)]",
  warn: "[--status-tone:var(--color-warn)]",
  danger: "[--status-tone:var(--color-danger)]",
};

export function StatusTag({
  tone = "neutral",
  icon,
  children,
  className = "",
  title,
}: {
  tone?: StatusTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span title={title} className={`status-tag ${TONE[tone]} ${className}`.trim()}>
      {icon}
      {children}
    </span>
  );
}
