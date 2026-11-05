"use client";
import { AnimatePresence, motion } from "framer-motion";
import { Trash2 } from "lucide-react";

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
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
  return (
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
                <Trash2 size={18} />
              </span>
              <h2 className="font-semibold dark:text-white">{request.title}</h2>
            </div>
            <p className="mt-3 text-sm leading-5 text-gray-600 dark:text-gray-300">{request.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={pending}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {pending ? "Deleting..." : request.confirmLabel ?? "Delete"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
