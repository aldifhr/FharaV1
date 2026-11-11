/**
 * UI-only preferences saved on this device (localStorage), set in the
 * Settings modal and read by the components they change. Server-side
 * behaviour lives in Convex (`appSettings`); these only change how this
 * browser renders and handles input.
 *
 * Every pref has a key, a default and a parser, so a hand-edited or stale
 * value falls back to the default instead of breaking a component.
 * Writers dispatch PREFS_EVENT so open components update at once.
 */
import { useCallback, useEffect, useState } from "react";

export const PREFS_EVENT = "fhara:prefs-changed";

type PrefSpec<T> = { key: string; defaultValue: T; parse: (raw: string) => T | undefined };

const bool = (key: string, defaultValue: boolean): PrefSpec<boolean> => ({
  key,
  defaultValue,
  parse: (raw) => (raw === "true" ? true : raw === "false" ? false : undefined),
});

const oneOf = <T extends string>(key: string, defaultValue: T, options: readonly T[]): PrefSpec<T> => ({
  key,
  defaultValue,
  parse: (raw) => (options as readonly string[]).includes(raw) ? (raw as T) : undefined,
});

const text = (key: string, defaultValue: string, maxLength = 500): PrefSpec<string> => ({
  key,
  defaultValue,
  parse: (raw) => (raw.length <= maxLength ? raw : undefined),
});

export const UI_PREFS = {
  /** Diffs: side-by-side or unified. */
  diffView: oneOf("fhara:diff-view", "unified", ["unified", "split"] as const),
  /** Diffs: only changed hunks, or the whole file (full-file viewer). */
  diffContext: oneOf("fhara:diff-context", "full", ["full", "changes"] as const),
  /** Diffs: file sections start expanded. */
  diffExpanded: bool("fhara:diff-expanded", true),
  /** Voice: show the mic button in the composer. */
  voiceEnabled: bool("fhara:voice-enabled", true),
  /** Voice: recognition language ("" = the browser language). */
  voiceLanguage: text("fhara:voice-language", "", 20),
  /** Voice: keep listening until stopped instead of one phrase. */
  voiceContinuous: bool("fhara:voice-continuous", false),
  /** Voice: send the message when dictation ends. */
  voiceAutoSend: bool("fhara:voice-auto-send", false),
  /** Threads: Enter sends (otherwise Ctrl/Cmd+Enter sends). */
  enterToSend: bool("fhara:enter-to-send", true),
  /** Threads: show streamed model output under running subtasks. */
  liveOutput: bool("fhara:live-output", true),
  /** Workspace: parent folder the New project form fills in. */
  projectsFolder: text("fhara:projects-folder", "", 500),
  /** Devices: desktop notification when something needs your attention. */
  notifyAttention: bool("fhara:notify-attention", false),
  /** Sidebar: collapsed to the icon rail (desktop). Reads the older "1"/"0" values too. */
  sidebarCollapsed: {
    key: "fhara-sidebar-collapsed",
    defaultValue: false,
    parse: (raw: string) => (raw === "true" || raw === "1" ? true : raw === "false" || raw === "0" ? false : undefined),
  } as PrefSpec<boolean>,
  /** Sidebar Threads: group rows by project, kind or status. */
  threadGroupBy: oneOf("fhara:thread-group-by", "project", ["project", "kind", "status"] as const),
  /** Sidebar Threads: show all rows, only ones that need you, or only unread ones. */
  threadFilter: oneOf("fhara:thread-filter", "all", ["all", "needsYou", "unread"] as const),
} as const;

export type UiPrefKey = keyof typeof UI_PREFS;
export type UiPrefValue<K extends UiPrefKey> = (typeof UI_PREFS)[K]["defaultValue"];

export function readUiPref<K extends UiPrefKey>(key: K): UiPrefValue<K> {
  const spec = UI_PREFS[key] as PrefSpec<UiPrefValue<K>>;
  if (typeof window === "undefined") return spec.defaultValue;
  try {
    const raw = window.localStorage.getItem(spec.key);
    if (raw === null) return spec.defaultValue;
    return spec.parse(raw) ?? spec.defaultValue;
  } catch {
    return spec.defaultValue;
  }
}

export function writeUiPref<K extends UiPrefKey>(key: K, value: UiPrefValue<K>): void {
  const spec = UI_PREFS[key];
  try {
    if (value === spec.defaultValue) window.localStorage.removeItem(spec.key);
    else window.localStorage.setItem(spec.key, String(value));
  } catch {
    /* storage denied */
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { key } }));
}

/** Remove every UI pref (Settings → Restore device defaults). */
export function resetUiPrefs(): void {
  try {
    for (const spec of Object.values(UI_PREFS)) window.localStorage.removeItem(spec.key);
  } catch {
    /* storage denied */
  }
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { key: "*" } }));
}

/** A pref as React state: SSR renders the default, then the stored value. */
export function useUiPref<K extends UiPrefKey>(key: K): [UiPrefValue<K>, (value: UiPrefValue<K>) => void] {
  const [value, setValue] = useState<UiPrefValue<K>>(UI_PREFS[key].defaultValue as UiPrefValue<K>);
  useEffect(() => {
    const sync = () => setValue(readUiPref(key));
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === UI_PREFS[key].key) sync();
    };
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  const set = useCallback((next: UiPrefValue<K>) => writeUiPref(key, next), [key]);
  return [value, set];
}

/** "My App" + "C:\\code" → "C:\\code\\my-app"; "/home/me/code/" → "/home/me/code/my-app". */
export function suggestProjectPath(folder: string, projectName: string): string {
  const base = folder.trim();
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base || !slug) return "";
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${slug}`;
}
