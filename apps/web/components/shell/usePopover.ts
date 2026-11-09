"use client";

import { useEffect, useRef, useState } from "react";

/** Open state + outside-click / Escape dismissal for a small popover. */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, toggle: () => setOpen((o) => !o), ref };
}

export const popoverClass =
  "absolute z-40 mt-2 overflow-hidden rounded-xl border border-line bg-panel py-1 text-sm text-ink shadow-[0_12px_32px_-12px_rgba(20,20,40,0.25)] dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]";

export const iconButtonClass =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40";
