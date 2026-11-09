"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { nextTrayIndex, type TrayAction, type TrayItem } from "@/api/convex/lib/decisionTray";

/**
 * "Keputusan diperlukan": one box docked directly above the chat composer
 * that pages through everything waiting on the user in this chat
 * (command approvals, file-change / push / plan approvals, task questions
 * and escalations, the CTO's open option prompt). One item at a time with
 * a "‹ 2 dari 3 ›" pager. The composer below doubles as free text for the
 * current item ("Tambahkan sesuatu…"). Enter in an empty composer runs the
 * primary action; Esc collapses.
 */

const BTN = "inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-[13px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ink-3 disabled:cursor-not-allowed disabled:opacity-50";
export const TRAY_BTN_PRIMARY = `${BTN} bg-ink text-canvas hover:opacity-90`;
export const TRAY_BTN_SECONDARY = `${BTN} border border-line bg-panel text-ink hover:bg-hover`;
export const TRAY_BTN_TEXT = `${BTN} text-ink-2 hover:bg-hover hover:text-ink`;

/** Pager + collapse state that survives the list changing under it. */
export function useDecisionTray(items: TrayItem[]) {
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const prevRef = useRef<TrayItem[]>(items);
  useEffect(() => {
    setIndex((i) => nextTrayIndex(prevRef.current, items, i));
    // A new item arriving re-opens a collapsed tray.
    if (items.some((item) => !prevRef.current.some((p) => p.key === item.key))) setCollapsed(false);
    prevRef.current = items;
  }, [items]);
  const current = items[Math.min(index, Math.max(0, items.length - 1))] ?? null;
  return {
    items,
    index: Math.min(index, Math.max(0, items.length - 1)),
    current,
    collapsed,
    /** Expanded and showing an item: the composer acts on it. */
    active: !collapsed && current !== null,
    setCollapsed,
    prev: () => setIndex((i) => (i - 1 + items.length) % Math.max(1, items.length)),
    next: () => setIndex((i) => (i + 1) % Math.max(1, items.length)),
  };
}

export type DecisionTrayState = ReturnType<typeof useDecisionTray>;

/** Composer placeholder while the tray is open on `item`. */
export function trayPlaceholder(item: TrayItem | null): string | undefined {
  if (!item) return undefined;
  if (item.composerMode === "answer") return "Tulis jawabanmu…";
  if (item.composerMode === "deny_with_note") return "Tambahkan sesuatu… (mengirim pesan menolak perintah ini)";
  return "Tambahkan sesuatu…";
}

const COMPOSER_HINT: Record<TrayItem["composerMode"], string> = {
  deny_with_note: "Membalas di chat menolak perintah ini dan meneruskan pesanmu ke agent.",
  answer: "Ketik jawabanmu di bawah, atau pilih di atas.",
  chat: "Ketik di bawah untuk menambahkan catatan.",
};

export default function DecisionsTray({
  tray,
  busy,
  onAction,
}: {
  tray: DecisionTrayState;
  busy?: string | null;
  onAction: (item: TrayItem, action: TrayAction) => void;
}) {
  const { items, index, current, collapsed } = tray;
  if (!current) return null;
  const many = items.length > 1;
  const disabled = Boolean(busy);
  return (
    <section
      aria-label="Keputusan diperlukan"
      className="w-full shrink-0 bg-panel px-3 pb-1.5 sm:px-8 lg:px-10"
    >
      <div className="rounded-xl border border-line bg-panel">
        <header className="flex items-center gap-2 px-3.5 py-2">
          <p className="text-[13px] font-semibold text-ink">Keputusan diperlukan</p>
          {many && (
            <div className="flex items-center gap-0.5 text-[12px] text-ink-3" role="group" aria-label="Pindah keputusan">
              <button type="button" onClick={tray.prev} aria-label="Sebelumnya" className="rounded-md p-0.5 hover:bg-hover hover:text-ink">
                <ChevronLeft size={14} />
              </button>
              <span className="tabular-nums">
                {index + 1} dari {items.length}
              </span>
              <button type="button" onClick={tray.next} aria-label="Berikutnya" className="rounded-md p-0.5 hover:bg-hover hover:text-ink">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => tray.setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Buka" : "Tutup"}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink"
          >
            {collapsed ? (
              <>
                <span className="max-w-[16rem] truncate">{current.title}</span>
                <ChevronUp size={14} />
              </>
            ) : (
              <ChevronDown size={14} />
            )}
          </button>
        </header>
        {!collapsed && (
          <div className="border-t border-line px-3.5 pb-3 pt-2.5">
            <p className="text-[14px] font-medium text-ink">{current.title}</p>
            {current.meta && <p className="mt-0.5 text-[12px] text-ink-3">{current.meta}</p>}
            {current.code && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12.5px] text-ink">
                {current.code}
              </pre>
            )}
            {current.warning && <p className="mt-1.5 text-[12px] text-ink-2">Selalu ditanyakan: {current.warning.toLowerCase()}.</p>}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {current.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onAction(current, action)}
                  className={
                    action.primary
                      ? TRAY_BTN_PRIMARY
                      : action.id === "deny" || action.id === "reject" || action.id === "open"
                        ? TRAY_BTN_TEXT
                        : TRAY_BTN_SECONDARY
                  }
                >
                  {busy === `${current.key}:${action.id}` ? "Menyimpan…" : action.label}
                  {action.primary && <span className="ml-1.5 hidden text-[11px] opacity-70 sm:inline">↵</span>}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-ink-3">{COMPOSER_HINT[current.composerMode]}</p>
          </div>
        )}
      </div>
    </section>
  );
}
