"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, Moon, Sun } from "lucide-react";
import Modal from "./Modal";
import { useFont, type FontChoice } from "@/components/ui/use-font";
import { useTheme } from "@/components/ui/use-theme";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

const FONT_OPTIONS: { value: FontChoice; label: string; description: string; style: CSSProperties }[] = [
  { value: "geist", label: "Geist", description: "Modern default", style: { fontFamily: "var(--font-geist)" } },
  { value: "inter", label: "Inter", description: "Clean UI sans", style: { fontFamily: "var(--font-inter)" } },
  { value: "system", label: "System", description: "Native OS font", style: { fontFamily: "ui-sans-serif, system-ui, sans-serif" } },
  { value: "jetbrains", label: "JetBrains Mono", description: "Monospaced", style: { fontFamily: "var(--font-jetbrains)" } },
];

interface SettingsContextValue {
  openSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used within SettingsProvider");
  return context;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openSettings = useCallback(() => setOpen(true), []);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal open={open} onClose={() => setOpen(false)} />
    </SettingsContext.Provider>
  );
}

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, setTheme } = useTheme();
  const { font, setFont } = useFont();

  if (!open) return null;

  return (
    <Modal title="Settings" onClose={onClose} maxWidth="max-w-2xl">
      <div className="mt-4 max-h-[70vh] overflow-y-auto pr-1">
        <div className="grid gap-4">
          {/* ponytail: grid stack instead of Tailwind v4 space-y-/divide- for per-section spacing */}
          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
            <h2 className="text-sm font-semibold">Appearance</h2>
            <p className="mt-1 text-xs text-gray-500">Choose how the workspace looks on this device.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                ] as const
              ).map(({ value, label, icon: Icon }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    aria-pressed={active}
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                      active
                        ? "border-[#6252d8] bg-[#6252d8]/10 text-[#4d3fbe] dark:text-[#b9b2ff]"
                        : "border-[#e5e3eb] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    }`}
                  >
                    <Icon size={16} />
                    {label}
                    {active && <Check size={14} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
            <h2 className="text-sm font-semibold">Font</h2>
            <p className="mt-1 text-xs text-gray-500">Interface typeface, saved on this device.</p>
            <div className="mt-3 grid gap-2">
              {FONT_OPTIONS.map((option) => {
                const active = font === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setFont(option.value)}
                    aria-pressed={active}
                    className={`rounded-xl border px-3 py-3 text-left transition ${
                      active
                        ? "border-[#6252d8] bg-[#6252d8]/10 dark:bg-[#6252d8]/15"
                        : "border-[#e5e3eb] hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{option.label}</span>
                      {active && <Check size={14} className="text-[#6252d8]" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">{option.description}</span>
                    <span className="mt-2 block truncate text-sm" style={option.style}>
                      The quick brown fox 0123
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-[#ebe9f0] bg-white/70 p-4 backdrop-blur-xl dark:border-gray-800 dark:bg-gray-900/60">
            <h2 className="text-sm font-semibold">Runtime</h2>
            <dl className="mt-3 grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500">Convex deployment</dt>
                <dd className="truncate font-mono text-xs">{convexUrl ?? "Not configured"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500">Font</dt>
                <dd className="text-xs capitalize">{font}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500">Mode</dt>
                <dd className="text-xs">Local single-user</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-gray-500">Theme</dt>
                <dd className="text-xs capitalize">{theme}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </Modal>
  );
}
