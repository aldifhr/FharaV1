"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Square, Trash2 } from "lucide-react";

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  /** "stop" for stopping a running task; default is the delete trash can. */
  icon?: "trash" | "stop";
};

export default function ConfirmDialog({
  request,
  pending,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = request !== null;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Focus Cancel on open, restore focus on close, and own Escape (capture
  // phase) so it doesn't also close a Modal underneath.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => cancelRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (!pending) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [open, pending, onCancel]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
          role="alertdialog"
          aria-modal="true"
          aria-label={request.title}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-gray-800 dark:bg-gray-900"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950">
                {request.icon === "stop" ? <Square size={16} /> : <Trash2 size={18} />}
              </span>
              <h2 className="font-semibold dark:text-white">{request.title}</h2>
            </div>
            <p className="mt-3 text-sm leading-5 text-gray-600 dark:text-gray-300">{request.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={onCancel}
                disabled={pending}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 outline-none transition focus-visible:ring-2 focus-visible:ring-[#635bff]/50 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white outline-none transition focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 hover:bg-red-700 disabled:opacity-50"
              >
                {pending ? "Working…" : request.confirmLabel ?? "Delete"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
