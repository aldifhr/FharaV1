"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { Card, CardContent } from "./ui/card";

export default function Modal({
  title,
  children,
  onClose,
  maxWidth = "max-w-md",
  fullScreen = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  maxWidth?: string;
  fullScreen?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Move focus into the dialog on open, keep Tab inside it, and give focus
  // back on close.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const firstField = panel?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstField ?? panel)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!panel?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [mounted]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const header = (
    <div className="flex items-center justify-between gap-4">
      <h2 className="min-w-0 truncate font-medium">{title}</h2>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg p-1.5 text-gray-500 outline-none focus-visible:ring-2 focus-visible:ring-ink/40 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-white"
        aria-label="Close"
      >
        <X size={17} />
      </button>
    </div>
  );

  if (!mounted) return null;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={
          fullScreen
            ? "w-full max-w-3xl"
            : `w-full ${maxWidth}`
        }
        onMouseDown={(event) => event.stopPropagation()}
        ref={panelRef}
        tabIndex={-1}
        style={{ outline: "none" }}
      >
        <Card className="max-h-[90dvh] overflow-hidden border-[#ebe9f0] bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-900">
          <CardContent className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden p-5">
            {header}
            <div className={fullScreen ? "mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1" : "min-h-0 flex-1 overflow-y-auto overscroll-contain"}>{children}</div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>,
    document.body
  );
}
