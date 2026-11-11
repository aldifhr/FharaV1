"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Width limits shared by the right-docked panels (task thread, inspector). */
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_DEFAULT_WIDTH = 390;
export const PANEL_WIDE_WIDTH = 640;
const KEYBOARD_STEP = 16;

/** A width kept inside the panel limits. */
export const clampPanelWidth = (width: number, min = PANEL_MIN_WIDTH, max = PANEL_MAX_WIDTH) => Math.min(max, Math.max(min, width));

/** Whether a panel is at (or near) its wide preset. */
export const isWidePanel = (width: number) => width >= PANEL_WIDE_WIDTH - 20;

/** The width the wide/narrow toggle goes to next. */
export const toggledPanelWidth = (width: number) => (isWidePanel(width) ? PANEL_DEFAULT_WIDTH : PANEL_WIDE_WIDTH);

/**
 * Drag and keyboard resizing for a panel docked to the right edge (split out of
 * TaskThreadPanel; the Inspector shell uses it too). Dragging the left-edge
 * handle sets the width from the pointer's distance to the right of the window
 * (minus `edgeOffset`, the panel's own margin); ArrowLeft widens, ArrowRight
 * narrows. Returns props for the separator element.
 */
export function useResizablePanel({
  width,
  onWidthChange,
  min = PANEL_MIN_WIDTH,
  max = PANEL_MAX_WIDTH,
  edgeOffset = 0,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  min?: number;
  max?: number;
  edgeOffset?: number;
}) {
  const [resizing, setResizing] = useState(false);
  const resizingRef = useRef(false);

  const onPointerDown = useCallback((event: PointerEvent) => {
    event.preventDefault();
    resizingRef.current = true;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (event: globalThis.PointerEvent) => {
      if (!resizingRef.current) return;
      // Right-docked: the width shrinks as the handle moves right.
      onWidthChange(clampPanelWidth(window.innerWidth - edgeOffset - event.clientX, min, max));
    };
    const handleUp = () => {
      resizingRef.current = false;
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing, onWidthChange, min, max, edgeOffset]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onWidthChange(clampPanelWidth(width + KEYBOARD_STEP, min, max));
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        onWidthChange(clampPanelWidth(width - KEYBOARD_STEP, min, max));
      }
    },
    [width, onWidthChange, min, max],
  );

  return {
    resizing,
    handleProps: {
      role: "separator" as const,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  };
}
