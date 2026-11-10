"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, Cpu, Moon, SlidersHorizontal, Sun } from "lucide-react";
import Modal from "./Modal";
import LlmSettingsSection from "./LlmSettings";
import { useFont, type FontChoice } from "@/components/ui/use-font";
import { useTheme } from "@/components/ui/use-theme";
import { BUDGET_STORAGE_KEY, readLocalBudget } from "@/lib/usageWeek";

const FONT_OPTIONS: { value: FontChoice; label: string; description: string; style: CSSProperties }[] = [
  { value: "geist", label: "Geist", description: "Modern default", style: { fontFamily: "var(--font-geist)" } },
  { value: "inter", label: "Inter", description: "Clean UI sans", style: { fontFamily: "var(--font-inter)" } },
  { value: "system", label: "System", description: "Native OS font", style: { fontFamily: "ui-sans-serif, system-ui, sans-serif" } },
  { value: "jetbrains", label: "JetBrains Mono", description: "Monospaced", style: { fontFamily: "var(--font-jetbrains)" } },
];

const TABS = [
  { value: "general", label: "General", icon: SlidersHorizontal },
  { value: "llm", label: "LLM & Models", icon: Cpu },
] as const;

type SettingsTab = (typeof TABS)[number]["value"];

interface SettingsContextValue {
  openSettings: (projectId?: string) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used within SettingsProvider");
  return context;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const openSettings = useCallback((nextProjectId?: string) => {
    if (nextProjectId) setProjectId(nextProjectId);
    setOpen(true);
  }, []);

  return (
    <SettingsContext.Provider value={{ openSettings }}>
      {children}
      <SettingsModal
        open={open}
        projectId={projectId}
        onProjectChange={setProjectId}
        onClose={() => setOpen(false)}
      />
    </SettingsContext.Provider>
  );
}

/** Weekly token budget for the sidebar usage meter, kept on this device. */
function BudgetField() {
  const [value, setValue] = useState("");
  useEffect(() => setValue(String(readLocalBudget() ?? "")), []);
  const save = (next: string) => {
    setValue(next);
    const n = Math.floor(Number(next));
    try {
      if (Number.isFinite(n) && n > 0) localStorage.setItem(BUDGET_STORAGE_KEY, String(n));
      else localStorage.removeItem(BUDGET_STORAGE_KEY);
    } catch {
      /* storage denied */
    }
    window.dispatchEvent(new Event("fhara:budget-changed"));
  };
  return (
    <section className="rounded-xl border border-line bg-panel p-3">
      <h2 className="text-[13px] font-semibold">Usage budget</h2>
      <p className="mt-0.5 text-[12px] text-ink-3">
        Weekly token budget for the sidebar meter (resets Monday 09:00). Leave empty to use the server&apos;s
        MOAGENT_WEEKLY_TOKEN_BUDGET, or show raw tokens when neither is set.
      </p>
      <input
        type="number"
        min={0}
        step={100000}
        inputMode="numeric"
        value={value}
        onChange={(e) => save(e.target.value)}
        placeholder="e.g. 2000000"
        aria-label="Weekly token budget"
        className="mt-2 h-9 w-full rounded-lg border border-line bg-panel px-3 text-[14px] text-ink outline-none focus:border-brand/50 focus:ring-2 focus:ring-brand/15"
      />
    </section>
  );
}

function SettingsModal({
  open,
  projectId,
  onProjectChange,
  onClose,
}: {
  open: boolean;
  projectId?: string;
  onProjectChange: (projectId?: string) => void;
  onClose: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const { font, setFont } = useFont();
  const [tab, setTab] = useState<SettingsTab>("general");

  if (!open) return null;

  return (
    <Modal title="Settings" onClose={onClose} maxWidth="max-w-2xl">
      <div className="mt-4 flex gap-1 rounded-xl border border-line bg-panel p-1" role="tablist" aria-label="Settings sections">
        {TABS.map(({ value, label, icon: Icon }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(value)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-brand/40 ${
                active ? "bg-brand-soft text-brand-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {tab === "llm" ? (
        <div className="mt-4">
          <LlmSettingsSection projectId={projectId} onProjectChange={onProjectChange} />
        </div>
      ) : (
        <div className="mt-4 grid gap-3">
            {/* ponytail: grid stack instead of Tailwind v4 space-y-/divide- for per-section spacing */}
            <section className="rounded-xl border border-line bg-panel p-3">
              <h2 className="text-[13px] font-semibold">Appearance</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">Choose how the workspace looks on this device.</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
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
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[13px] font-medium transition ${
                        active
                          ? "border-brand bg-brand-soft text-brand-ink"
                          : "border-line hover:bg-hover"
                      }`}
                    >
                      <Icon size={14} />
                      {label}
                      {active && <Check size={12} className="ml-auto" />}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-panel p-3">
              <h2 className="text-[13px] font-semibold">Font</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">Interface typeface, saved on this device.</p>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {FONT_OPTIONS.map((option) => {
                  const active = font === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setFont(option.value)}
                      aria-pressed={active}
                      className={`rounded-lg border px-2 py-1.5 text-left transition ${
                        active
                          ? "border-brand bg-brand-soft"
                          : "border-line hover:bg-hover"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-semibold">{option.label}</span>
                        {active && <Check size={12} className="shrink-0 text-brand-ink" />}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-gray-500">{option.description}</span>
                      <span className="mt-0.5 block truncate text-[11px]" style={option.style}>
                        The quick brown fox 0123
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
            <BudgetField />
        </div>
      )}
    </Modal>
  );
}
