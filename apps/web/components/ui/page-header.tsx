"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusTag, type StatusTone } from "./status-tag";

/**
 * Page header (dashboard restyle F3): an optional leading mark, a caption line
 * above the title, the title, a mono id with a copy button, a StatusTag for the
 * state, a meta line, and a right-hand action slot (outline buttons plus at most
 * one ink primary). `variant="bar"` is the compact 64px strip used by the chat
 * header; `variant="page"` is the large title at the top of a page.
 */
export type PageHeaderStatus = { tone: StatusTone; label: string; title?: string };

/** Outline action for the header slot. */
export const HEADER_ACTION =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-field border border-line bg-panel px-2.5 text-[12.5px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50";
/** A mono id that copies itself; the icon turns into a check for a moment. */
function CopyId({ id, label = "id", display }: { id: string; label?: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? "Copied" : `Copy ${label}`}
      aria-label={copied ? `${label} copied` : `Copy ${label} ${id}`}
      className="group inline-flex min-w-0 items-center gap-1 rounded-field px-1 -mx-1 outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/30"
    >
      <span className="text-mono-id truncate">{display ?? id}</span>
      {copied ? (
        <Check size={12} className="shrink-0 text-ok" aria-hidden="true" />
      ) : (
        <Copy size={12} className="shrink-0 text-ink-3 opacity-60 transition group-hover:opacity-100" aria-hidden="true" />
      )}
    </button>
  );
}

/** Short form of a long Convex id: first 6 and last 4 characters. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function PageHeader({
  variant = "page",
  leading,
  eyebrow,
  title,
  id,
  idLabel,
  status,
  meta,
  actions,
  children,
  className = "",
}: {
  variant?: "page" | "bar";
  leading?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
  id?: string | null;
  idLabel?: string;
  status?: PageHeaderStatus | null;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Extra rows under the header (warnings, errors). */
  children?: ReactNode;
  className?: string;
}) {
  const bar = variant === "bar";
  const idRow =
    id || status ? (
      <span className="flex min-w-0 items-center gap-2">
        {status && (
          <StatusTag tone={status.tone} title={status.title}>
            {status.label}
          </StatusTag>
        )}
        {id && <CopyId id={id} label={idLabel} display={shortId(id)} />}
      </span>
    ) : null;

  if (bar) {
    return (
      <div className={`flex min-w-0 items-center gap-3 ${className}`.trim()}>
        {leading}
        <div className="min-w-0">
          <h1 className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold leading-tight text-ink">{title}</h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            {meta}
            {idRow && <span className="max-sm:hidden">{idRow}</span>}
          </div>
        </div>
        {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
      </div>
    );
  }

  return (
    <header className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {leading}
          <div className="min-w-0">
            {eyebrow && <p className="truncate text-[13px] text-ink-3">{eyebrow}</p>}
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
            {idRow && <div className="mt-2">{idRow}</div>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {meta && <div className="mt-2">{meta}</div>}
      {children}
    </header>
  );
}
