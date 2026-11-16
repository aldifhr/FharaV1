"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";

export type ModelOption = { id: string; label: string; provider: string };

/**
 * Plan 055: pick the model for this turn's reply. "Auto" follows the global
 * model list in Settings → LLM & Models; a pick leads the chain with the
 * global list as fallback (the backend ignores a pick it cannot serve).
 */
export default function ModelPicker({
  models,
  modelId,
  onModelChange,
}: {
  models: ModelOption[];
  modelId?: string | null;
  onModelChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = modelId ? models.find((m) => m.id === modelId) ?? null : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const optionClass = "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => models.length > 0 && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={models.length === 0}
        aria-label={selected ? `Model: ${selected.label}` : "Model: Auto"}
        title={selected ? `${selected.label} on ${selected.provider}` : "Auto — follow the global model list (Settings → LLM & Models)"}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
      >
        <Cpu size={14} className="shrink-0 text-ink-3" aria-hidden="true" />
        <span className="max-w-28 truncate max-sm:hidden">{selected?.label ?? "Auto"}</span>
        <ChevronDown size={13} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <ul role="listbox" aria-label="Model" className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-[0_12px_32px_-12px_rgba(20,20,40,0.3)]">
          <li role="option" aria-selected={!modelId}>
            <button
              type="button"
              onClick={() => {
                onModelChange(null);
                setOpen(false);
              }}
              className={optionClass}
            >
              <span className="min-w-0 flex-1">
                <span className={`block text-[13.5px] text-ink ${!modelId ? "font-medium" : ""}`}>Auto</span>
                <span className="block text-[12px] text-ink-3">Follow the global model list</span>
              </span>
              {!modelId && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
            </button>
          </li>
          {models.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === modelId}>
              <button
                type="button"
                onClick={() => {
                  onModelChange(m.id);
                  setOpen(false);
                }}
                className={optionClass}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13.5px] text-ink ${m.id === modelId ? "font-medium" : ""}`}>{m.label}</span>
                  <span className="block truncate text-[12px] text-ink-3">{m.provider}</span>
                </span>
                {m.id === modelId && <Check size={14} className="shrink-0 text-ink" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
