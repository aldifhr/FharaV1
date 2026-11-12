/**
 * Rebindable keyboard shortcuts (Settings → Keybindings).
 *
 * Each action has a default chord; the user's overrides are stored on this
 * device (localStorage) and every handler matches through `matchesChord`,
 * so a rebind takes effect at once. "Mod" is Cmd on macOS and Ctrl
 * elsewhere (either is accepted when matching).
 */
import { useEffect, useState } from "react";

export const KEYBINDINGS_STORAGE_KEY = "fhara:keybindings";
export const KEYBINDINGS_EVENT = "fhara:keybindings-changed";

export const KEYBINDING_ACTIONS = [
  { id: "commandMenu", label: "Open command menu", scope: "Global", defaultChord: "Mod+K" },
  { id: "openSettings", label: "Open settings", scope: "Global", defaultChord: "Mod+," },
  { id: "composerBold", label: "Bold", scope: "Composer", defaultChord: "Mod+B" },
  { id: "composerItalic", label: "Italic", scope: "Composer", defaultChord: "Mod+I" },
  { id: "composerCode", label: "Inline code", scope: "Composer", defaultChord: "Mod+E" },
  { id: "composerQueue", label: "Queue message", scope: "Composer", defaultChord: "Alt+Enter" },
  { id: "toggleChanges", label: "Open or close the task's changes", scope: "Task thread", defaultChord: "Mod+Shift+G" },
  { id: "nextFile", label: "Next changed file", scope: "Changes", defaultChord: "Alt+ArrowDown" },
  { id: "prevFile", label: "Previous changed file", scope: "Changes", defaultChord: "Alt+ArrowUp" },
  { id: "sendRound", label: "Send draft comments as a review round", scope: "Changes", defaultChord: "Mod+Shift+Enter" },
  { id: "nextThread", label: "Next thread in the sidebar", scope: "Sidebar", defaultChord: "Alt+Shift+ArrowDown" },
  { id: "prevThread", label: "Previous thread in the sidebar", scope: "Sidebar", defaultChord: "Alt+Shift+ArrowUp" },
] as const;

export type KeybindingId = (typeof KEYBINDING_ACTIONS)[number]["id"];
export type Keybindings = Record<KeybindingId, string>;

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Canonical chord text ("Shift+Mod+k" → "Mod+Shift+K"), or null when invalid. */
export function normalizeChord(chord: string): string | null {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  // "Mod++" (plus key) splits into an empty tail; treat a trailing "+" as the key.
  if (chord.trim().endsWith("++")) parts.push("+");
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  const mods = new Set<string>();
  for (const raw of parts.slice(0, -1)) {
    const mod = MODIFIERS.find((m) => m.toLowerCase() === raw.toLowerCase()) ?? (/^(cmd|meta|command)$/i.test(raw) ? "Mod" : null);
    if (!mod) return null;
    mods.add(mod);
  }
  if (!key || MODIFIERS.some((m) => m.toLowerCase() === key.toLowerCase())) return null;
  const ordered = MODIFIERS.filter((m) => mods.has(m));
  return [...ordered, normalizeKey(key)].join("+");
}

/** Chord text for a keydown event (for "press a key to rebind"); null for a bare modifier. */
export function chordFromEvent(event: KeyLike): string | null {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
}

/** Whether a keydown event is the chord. Mod accepts Cmd or Ctrl. */
export function matchesChord(event: KeyLike, chord: string): boolean {
  const normalized = normalizeChord(chord);
  if (!normalized) return false;
  const parts = normalized.split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const wantMod = mods.has("Mod") || mods.has("Ctrl");
  if (wantMod !== (event.metaKey || event.ctrlKey)) return false;
  if (mods.has("Alt") !== event.altKey) return false;
  if (mods.has("Shift") !== event.shiftKey) return false;
  return normalizeKey(event.key) === key;
}

export function defaultKeybindings(): Keybindings {
  return Object.fromEntries(KEYBINDING_ACTIONS.map((a) => [a.id, a.defaultChord])) as Keybindings;
}

/** Defaults with valid stored overrides applied. */
export function parseKeybindings(raw: string | null): Keybindings {
  const out = defaultKeybindings();
  if (!raw) return out;
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    for (const action of KEYBINDING_ACTIONS) {
      const value = stored[action.id];
      const chord = typeof value === "string" ? normalizeChord(value) : null;
      if (chord) out[action.id] = chord;
    }
  } catch {
    /* corrupt value: defaults */
  }
  return out;
}

/** Actions other than `id` already using `chord` (a conflict to show). */
export function chordConflicts(bindings: Keybindings, id: KeybindingId, chord: string): KeybindingId[] {
  const normalized = normalizeChord(chord);
  if (!normalized) return [];
  return KEYBINDING_ACTIONS.filter((a) => a.id !== id && normalizeChord(bindings[a.id]) === normalized).map((a) => a.id);
}

export function readKeybindings(): Keybindings {
  if (typeof window === "undefined") return defaultKeybindings();
  try {
    return parseKeybindings(window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY));
  } catch {
    return defaultKeybindings();
  }
}

export function writeKeybindings(bindings: Keybindings): void {
  const defaults = defaultKeybindings();
  const overrides: Partial<Keybindings> = {};
  for (const action of KEYBINDING_ACTIONS) {
    if (bindings[action.id] !== defaults[action.id]) overrides[action.id] = bindings[action.id];
  }
  try {
    if (Object.keys(overrides).length === 0) window.localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
    else window.localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* storage denied */
  }
  window.dispatchEvent(new Event(KEYBINDINGS_EVENT));
}

const ARROWS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** Display form: "Mod+K" → "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function formatChord(chord: string, mac: boolean): string {
  const normalized = normalizeChord(chord) ?? chord;
  if (!mac) return normalized.replace(/^Mod\b/, "Ctrl").replace(/\+Mod\b/, "+Ctrl");
  return normalized
    .split("+")
    .map((p) => (p === "Mod" ? "⌘" : p === "Alt" ? "⌥" : p === "Shift" ? "⇧" : p === "Ctrl" ? "⌃" : (ARROWS[p] ?? p)))
    .join("");
}

/** Current bindings as React state (updates on rebind in any tab). */
export function useKeybindings(): Keybindings {
  const [bindings, setBindings] = useState<Keybindings>(defaultKeybindings);
  useEffect(() => {
    const sync = () => setBindings(readKeybindings());
    sync();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === KEYBINDINGS_STORAGE_KEY) sync();
    };
    window.addEventListener(KEYBINDINGS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(KEYBINDINGS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return bindings;
}
