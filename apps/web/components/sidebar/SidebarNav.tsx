"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { readUiPref } from "@/lib/uiPrefs";

export type NavIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

/** Thin line icons, one size everywhere in the sidebar. */
export const ICON_SIZE = 16;
export const ICON_STROKE = 1.6;

const rowBase =
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-field px-2 text-[14px] outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30";
const rowIdle = "text-ink-2 hover:bg-hover hover:text-ink";
const rowActive = "bg-hover font-medium text-ink";

/** Small uppercase group label: WORK, BUILD, OBSERVE. */
export function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label}>
      <p className="text-caption px-2 pb-1">{label}</p>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

/** One nav row in the expanded sidebar: line icon, label, optional right-aligned count. */
export function NavRow({
  icon: Icon,
  label,
  href,
  onClick,
  active = false,
  count,
  buttonRef,
  expanded,
}: {
  icon: NavIcon;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  count?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  const inner = (
    <>
      <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} className={active ? "text-ink" : "text-ink-3"} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && count > 0 && <span className="text-[12px] tabular-nums text-ink-3">{count}</span>}
    </>
  );
  const className = `${rowBase} ${active ? rowActive : rowIdle}`;
  return href ? (
    <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} className={className}>
      {inner}
    </Link>
  ) : (
    <button type="button" ref={buttonRef} onClick={onClick} aria-expanded={expanded} className={className}>
      {inner}
    </button>
  );
}

/** Collapsed sidebar: an icon button with a hover/focus tooltip in a portal (the rail scrolls). */
export function RailItem({
  icon: Icon,
  label,
  href,
  onClick,
  active = false,
  dot = false,
  buttonRef,
  expanded,
}: {
  icon: NavIcon;
  label: string;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  dot?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ x: r.right + 10, y: r.top + r.height / 2 });
  };
  const common = {
    "aria-label": label,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: () => setTip(null),
    className: `relative flex h-9 w-9 shrink-0 items-center justify-center rounded-field outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 ${
      active ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
    }`,
  };
  const inner = (
    <>
      <Icon size={17} strokeWidth={ICON_STROKE} />
      {dot && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-warn" />}
    </>
  );
  return (
    <>
      {href ? (
        <Link href={href} aria-current={active ? "page" : undefined} onClick={onClick} {...common}>
          {inner}
        </Link>
      ) : (
        <button type="button" ref={buttonRef} onClick={onClick} aria-expanded={expanded} {...common}>
          {inner}
        </button>
      )}
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-[80] -translate-y-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-medium text-canvas shadow-lg"
            style={{ left: tip.x, top: tip.y }}
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}

/**
 * Settings → Devices: a desktop notification when the "needs you" count
 * goes up while this window is in the background. Off unless the user
 * turned it on (and the browser granted permission).
 */
function useAttentionNotification(total: number | undefined) {
  const previous = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (total === undefined) return;
    const before = previous.current;
    previous.current = total;
    if (before === undefined || total <= before) return;
    if (!readUiPref("notifyAttention")) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    try {
      const note = new Notification("Fhara", {
        body: total === 1 ? "1 thing needs you" : `${total} things need you`,
        tag: "fhara-needs-you",
      });
      note.onclick = () => {
        window.focus();
        window.location.assign("/inbox");
      };
    } catch {
      /* notifications unavailable */
    }
  }, [total]);
}

/** The "needs you" total for the Inbox row (count) and rail (dot); also drives the desktop notification. */
export function InboxNav({
  icon,
  active,
  rail,
  onNavigate,
}: {
  icon: NavIcon;
  active: boolean;
  rail: boolean;
  onNavigate?: () => void;
}) {
  const needs = useQuery(api.shell.needsYou, {});
  useAttentionNotification(needs?.total);
  const total = needs?.total ?? 0;
  return rail ? (
    <RailItem icon={icon} label={total ? `Inbox (${total})` : "Inbox"} href="/inbox" active={active} dot={total > 0} onClick={onNavigate} />
  ) : (
    <NavRow icon={icon} label="Inbox" href="/inbox" active={active} count={total} onClick={onNavigate} />
  );
}
