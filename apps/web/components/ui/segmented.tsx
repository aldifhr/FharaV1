"use client";

/**
 * Small neutral segmented control (Library tabs, Memory scopes). Theme
 * tokens only, so it follows dark and light mode.
 */
export default function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg border border-line bg-panel p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1 text-[13px] outline-none transition focus-visible:ring-2 focus-visible:ring-ink/30 ${
              active ? "bg-hover font-medium text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
