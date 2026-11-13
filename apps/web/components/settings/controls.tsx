"use client";

/**
 * Building blocks for the Settings tabs: one section per topic, one row
 * per setting. Theme tokens only (canvas/panel/hover, line, ink), no
 * tinted cards. Server knobs go through `useKnob`, which reads and writes
 * the Convex `appSettings` row.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/api/convex/_generated/api";
import { useToast } from "@/components/Toasts";
import type { SettingKey } from "@/api/convex/lib/appSettings";

export const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "Please try again.";

export const INPUT =
  "h-8 rounded-lg border border-line bg-canvas px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3 disabled:opacity-50";
export const BUTTON =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-50";
export const LINK_BUTTON = "text-[12px] text-ink-3 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50";

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
      {description && <p className="mt-0.5 text-[12px] text-ink-3">{description}</p>}
      <div className="mt-2.5 divide-y divide-line overflow-hidden rounded-xl border border-line bg-canvas">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  htmlFor,
  children,
  stacked = false,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  /** Control under the text instead of beside it (lists, long fields). */
  stacked?: boolean;
}) {
  const text = (
    <span className="min-w-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
          {label}
        </label>
      ) : (
        <span className="block text-[13px] font-medium text-ink">{label}</span>
      )}
      {description && <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-3">{description}</span>}
    </span>
  );
  if (stacked) {
    return (
      <div className="px-4 py-3.5">
        {text}
        {children && <div className="mt-2.5">{children}</div>}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      {text}
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
        checked ? "border-ink bg-ink" : "border-line bg-hover"
      }`}
    >
      <span
        className={`absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-canvas shadow-sm transition-[left] ${
          checked ? "left-[18px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
  id,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${INPUT} pr-7`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Text/number field that saves on blur or Enter (not on every key), so a
 * half-typed value never reaches the worker.
 */
export function CommitField({
  value,
  onCommit,
  label,
  placeholder,
  type = "text",
  width = "w-56",
  disabled,
  id,
  suffix,
}: {
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  label: string;
  placeholder?: string;
  type?: "text" | "number";
  width?: string;
  disabled?: boolean;
  id?: string;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) void onCommit(draft.trim());
  };
  return (
    <span className="flex items-center gap-1.5">
      <input
        id={id}
        aria-label={label}
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className={`${INPUT} ${width}`}
      />
      {suffix && <span className="text-[12px] text-ink-3">{suffix}</span>}
    </span>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className="text-[12px] text-ink-3">{children}</span>;
}

/** "3 min ago" style, for last-run and heartbeat times. */
export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const diff = Math.max(0, now - ms);
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function useAppSettings() {
  return useQuery(api.appSettings.get, {});
}

/**
 * One server knob: its effective value (UI override, else the Convex env
 * for API knobs, else the default), whether it is overridden, and a saver.
 */
function useKnob(key: SettingKey) {
  const settings = useAppSettings();
  const setValue = useMutation(api.appSettings.setValue);
  const toast = useToast();
  const entry = settings?.knobs[key];
  const override = entry?.override ?? null;
  const value = override ?? entry?.env ?? entry?.defaultValue ?? "";
  const save = async (next: string) => {
    try {
      await setValue({ key, value: next });
    } catch (err) {
      toast("error", "Couldn't save the setting", errorText(err));
    }
  };
  return {
    loading: settings === undefined,
    value,
    overridden: override !== null,
    defaultValue: entry?.defaultValue ?? "",
    save,
    reset: () => save(""),
  };
}

function knobBool(value: string): boolean {
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/** A boolean server knob as a switch row. */
export function KnobToggle({ knob, label, description }: { knob: SettingKey; label: string; description?: ReactNode }) {
  const k = useKnob(knob);
  return (
    <Row label={label} description={description}>
      {k.overridden && (
        <button type="button" className={LINK_BUTTON} onClick={() => void k.reset()}>
          Reset
        </button>
      )}
      <Toggle label={label} checked={knobBool(k.value)} disabled={k.loading} onChange={(next) => void k.save(String(next))} />
    </Row>
  );
}

/** A numeric server knob shown in a friendlier unit (ms → minutes, …). */
export function KnobNumber({
  knob,
  label,
  description,
  unit,
  factor = 1,
  placeholder,
}: {
  knob: SettingKey;
  label: string;
  description?: ReactNode;
  unit?: string;
  /** Stored value = shown value × factor. */
  factor?: number;
  placeholder?: string;
}) {
  const k = useKnob(knob);
  const shown = k.value === "" ? "" : String(Math.round((Number(k.value) / factor) * 100) / 100);
  const id = `knob-${knob}`;
  return (
    <Row label={label} description={description} htmlFor={id}>
      {k.overridden && (
        <button type="button" className={LINK_BUTTON} onClick={() => void k.reset()}>
          Reset
        </button>
      )}
      <CommitField
        id={id}
        label={label}
        type="number"
        width="w-24"
        value={shown}
        placeholder={placeholder}
        suffix={unit}
        disabled={k.loading}
        onCommit={(next) => k.save(next === "" ? "" : String(Math.round(Number(next) * factor)))}
      />
    </Row>
  );
}

/** A string server knob (paths, names). Empty = back to the default. */
export function KnobText({
  knob,
  label,
  description,
  placeholder,
  width = "w-64",
}: {
  knob: SettingKey;
  label: string;
  description?: ReactNode;
  placeholder?: string;
  width?: string;
}) {
  const k = useKnob(knob);
  const id = `knob-${knob}`;
  return (
    <Row label={label} description={description} htmlFor={id}>
      <CommitField
        id={id}
        label={label}
        value={k.overridden ? k.value : ""}
        placeholder={placeholder ?? (k.defaultValue || "Not set")}
        width={width}
        disabled={k.loading}
        onCommit={(next) => k.save(next)}
      />
    </Row>
  );
}

/** An enum server knob as a select row. */
export function KnobSelect<T extends string>({
  knob,
  label,
  description,
  options,
}: {
  knob: SettingKey;
  label: string;
  description?: ReactNode;
  options: readonly { value: T; label: string }[];
}) {
  const k = useKnob(knob);
  return (
    <Row label={label} description={description}>
      <Select label={label} value={k.value as T} options={options} disabled={k.loading} onChange={(next) => void k.save(next)} />
    </Row>
  );
}
