"use client";

/**
 * Paradev C2: the composer's "/" menu (plan audit/paradev-plan-2026-11-11.md,
 * P-C). Pattern only from superset-sh/superset `SlashCommandMenu.tsx` (MIT,
 * see THIRD_PARTY_NOTICES.md): rows "/name argumentHint" with the description
 * under it, the active row kept in view, mouse-down that never blurs the
 * textarea. Paradev's "builtin" mini-badge is not carried over; groups are
 * plain text labels.
 *
 * The textarea keeps focus and drives the keys (ChatComposer); this list only
 * renders and reports clicks. Ids follow `${id}-${index}` so the textarea's
 * aria-activedescendant can point at the active option.
 */
import { useEffect, useRef } from "react";
import type { SlashMenuEntry } from "@/lib/slashMenu";

export default function SlashMenu({
  id,
  entries,
  activeIndex,
  onHover,
  onPick,
  className,
}: {
  id: string;
  entries: SlashMenuEntry[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (entry: SlashMenuEntry) => void;
  className: string;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${activeIndex}`)}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex]);

  const commands = entries.map((entry, index) => ({ entry, index })).filter((r) => r.entry.entryKind !== "skill");
  const skills = entries.map((entry, index) => ({ entry, index })).filter((r) => r.entry.entryKind === "skill");
  const groups = [
    { key: "commands", label: "Commands", rows: commands },
    { key: "skills", label: "Skills", rows: skills },
  ].filter((g) => g.rows.length > 0);

  return (
    <ul ref={listRef} id={id} role="listbox" aria-label="Commands and skills" className={className}>
      {groups.map((group) => (
        <li key={group.key} role="presentation">
          <ul role="group" aria-labelledby={`${id}-${group.key}`}>
            <li role="presentation" id={`${id}-${group.key}`} className="px-3 pb-1 pt-2 text-[11px] font-medium text-ink-3">
              {group.label}
            </li>
            {group.rows.map(({ entry, index }) => {
              const active = index === activeIndex;
              return (
                <li
                  key={`${entry.entryKind}:${entry.name}`}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={active}
                  aria-disabled={entry.disabled || undefined}
                  onMouseEnter={() => onHover(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => !entry.disabled && onPick(entry)}
                  className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 ${active ? "bg-hover" : ""} ${entry.disabled ? "cursor-default" : ""}`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className={`font-mono text-[13px] font-medium ${entry.disabled ? "text-ink-3" : "text-ink"}`}>/{entry.name}</span>
                    {entry.argumentHint && <span className="truncate font-mono text-[12px] text-ink-3">{entry.argumentHint}</span>}
                    {entry.disabled && entry.disabledNote && <span className="ml-auto shrink-0 text-[11px] text-ink-3">{entry.disabledNote}</span>}
                  </span>
                  {entry.description && <span className="truncate text-[12.5px] text-ink-3">{entry.description}</span>}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
