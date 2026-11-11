"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { changedKeys, sameValue, type Draft } from "@/lib/inspectorDraft";

/**
 * Dirty-state hook for an Inspector form (dashboard F4). `base` is the saved
 * value from the server. Edits go into a draft; Discard restores the saved
 * value; `commit` adopts the draft as saved after a successful Save. While the
 * draft is clean, a new `base` from the server replaces it, so a live update
 * never shows as an edit; while it is dirty the user's edits win.
 */
export function useInspectorDraft<T extends Draft>(base: T) {
  const [saved, setSaved] = useState<T>(base);
  const [draft, setDraft] = useState<T>(base);
  const [editedAt, setEditedAt] = useState<number | null>(null);
  const changed = useMemo(() => changedKeys(saved, draft), [saved, draft]);
  const dirty = changed.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const baseKey = JSON.stringify(base);
  useEffect(() => {
    setSaved((prev) => (sameValue(prev, base) ? prev : base));
    if (!dirtyRef.current) setDraft((prev) => (sameValue(prev, base) ? prev : base));
    // baseKey stands in for `base`, which is a new object on every render.
  }, [baseKey]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setEditedAt(Date.now());
  }, []);

  const update = useCallback((patch: Partial<T>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setEditedAt(Date.now());
  }, []);

  const discard = useCallback(() => {
    setDraft(saved);
    setEditedAt(null);
  }, [saved]);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commit = useCallback((next?: T) => {
    const value = next ?? draftRef.current;
    setSaved(value);
    setDraft(value);
    setEditedAt(null);
  }, []);

  const isChanged = useCallback((key: keyof T) => changed.includes(key), [changed]);

  return { draft, saved, set, update, discard, commit, dirty, changed, isChanged, editedAt };
}

export type InspectorDraft<T extends Draft> = ReturnType<typeof useInspectorDraft<T>>;
