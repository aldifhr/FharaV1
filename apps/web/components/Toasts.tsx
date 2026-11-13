"use client";
import type { ReactNode } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; title: string; message?: string };

type ToastState = {
  toasts: Toast[];
  push: (kind: ToastKind, title: string, message?: string) => void;
  dismiss: (id: number) => void;
};

const AUTO_DISMISS_MS = 4200;

const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (kind, title, message) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, message }] }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
      AUTO_DISMISS_MS
    );
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Same call signature as before: `toast(kind, title, message?)`. */
export function useToast() {
  return useToastStore((s) => s.push);
}

const icons = { success: <CheckCircle2 size={16} />, error: <AlertTriangle size={16} />, info: <Info size={16} /> };
const styles = { success: "text-emerald-600 dark:text-emerald-400", error: "text-red-600 dark:text-red-400", info: "text-sky-600 dark:text-sky-400" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(92vw,360px)] flex-col gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-gray-200 bg-white p-3 shadow-2xl dark:border-gray-800 dark:bg-gray-900"
              role="status"
            >
              <span className={`mt-0.5 shrink-0 ${styles[t.kind]}`}>{icons[t.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold dark:text-white">{t.title}</p>
                {t.message && <p className="mt-0.5 break-words text-xs text-gray-500 dark:text-gray-400">{t.message}</p>}
              </div>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}
