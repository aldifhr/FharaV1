"use client";

export type LibrarySkill = { _id: string; name: string; description?: string; version?: number; versionCount?: number };

/**
 * Checkbox list of library skills (order of picking = prompt order). With
 * `pins`, each picked skill gets a version menu: Latest or a pinned vN.
 */
export default function SkillPicker({
  skills,
  value,
  onChange,
  pins,
  onPinChange,
}: {
  skills: LibrarySkill[] | undefined;
  value: string[];
  onChange: (next: string[]) => void;
  pins?: Record<string, number | undefined>;
  onPinChange?: (skillId: string, version: number | undefined) => void;
}) {
  const hint = "text-[12px] text-ink-3";
  if (skills === undefined) return <p className={hint}>Loading…</p>;
  if (skills.length === 0) return <p className={hint}>No skills in the library yet.</p>;
  return (
    <div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-lg border border-line p-3">
      {skills.map((skill) => (
        <label key={skill._id} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={value.includes(skill._id)}
            onChange={() => onChange(value.includes(skill._id) ? value.filter((id) => id !== skill._id) : [...value, skill._id])}
            className="accent-current"
          />
          <span className="truncate">{skill.name}</span>
          {skill.description && <span className="min-w-0 flex-1 truncate text-ink-3">· {skill.description}</span>}
          {pins && onPinChange && value.includes(skill._id) && (skill.versionCount ?? 0) > 1 && (
            <select
              aria-label={`Version of ${skill.name}`}
              value={pins[skill._id] ?? ""}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onPinChange(skill._id, e.target.value ? Number(e.target.value) : undefined)}
              className="ml-auto shrink-0 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[12px] text-ink-2 outline-none focus:border-ink-3"
            >
              <option value="">Latest{skill.version ? ` (v${skill.version})` : ""}</option>
              {Array.from({ length: skill.versionCount ?? 0 }, (_, i) => (skill.versionCount ?? 0) - i).map((v) => (
                <option key={v} value={v}>
                  Pin v{v}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
    </div>
  );
}
