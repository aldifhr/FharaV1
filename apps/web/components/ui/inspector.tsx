"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { editedLabel } from "@/lib/inspectorDraft";
import { useResizablePanel } from "@/lib/useResizablePanel";

/**
 * Inspector side panel (dashboard restyle F4): a `w-inspector` panel on the
 * right with a header (icon, title, close), underline tabs, a scrolling body of
 * caption field rows on `bg-inset`, and a sticky footer ("Edited …" with
 * Discard / Save in ink). Phones get it full screen. Theme tokens only.
 *
 * F7: the shell is split into InspectorSurface (floating, docked or sheet, with
 * an optional drag-resize edge from useResizablePanel) and InspectorHeader, so
 * the task thread renders on the same shell as the modal inspector.
 */
export function Inspector({
  title,
  subtitle,
  icon,
  status,
  actions,
  tabs,
  onClose,
  children,
  label,
  width,
  onWidthChange,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** A StatusTag next to the title. */
  status?: ReactNode;
  /** Small outline actions in the header, left of close. */
  actions?: ReactNode;
  /** Underline tabs under the header (see InspectorTabs). */
  tabs?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name when `title` is not plain text. */
  label?: string;
  /** With onWidthChange: a resizable width instead of the fixed w-inspector. */
  width?: number;
  onWidthChange?: (width: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [mounted, onClose]);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close panel" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-ink/10" />
      <InspectorSurface
        ref={panelRef}
        variant="floating"
        role="dialog"
        aria-modal
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        width={width}
        onWidthChange={onWidthChange}
      >
        <InspectorHeader titleId={titleId} title={title} subtitle={subtitle} icon={icon} status={status} actions={actions} onClose={onClose} />
        {tabs}
        <div className="shell-scroll relative flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </InspectorSurface>
    </div>,
    document.body,
  );
}

const SURFACE = {
  // Modal inspector: a floating card; phones get it full screen.
  floating:
    "relative m-2 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-panel border border-line bg-panel text-ink shadow-xl outline-none max-sm:m-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-none",
  // Docked beside the main area (the task thread on desktop).
  docked: "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-panel text-ink outline-none",
  // Phone sheet: fills the screen.
  sheet: "relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-panel text-ink outline-none",
} as const;

/**
 * The inspector's panel surface. `width` + `onWidthChange` make it resizable
 * from its left edge (never on the phone sheet); without them it is w-inspector.
 */
export function InspectorSurface({
  variant,
  width,
  onWidthChange,
  resizeLabel = "Resize panel",
  ref,
  role,
  "aria-modal": ariaModal,
  "aria-labelledby": labelledBy,
  "aria-label": ariaLabel,
  children,
}: {
  variant: keyof typeof SURFACE;
  width?: number;
  onWidthChange?: (width: number) => void;
  resizeLabel?: string;
  ref?: Ref<HTMLDivElement>;
  role?: string;
  "aria-modal"?: boolean;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  children: ReactNode;
}) {
  const sized = variant !== "sheet" && width !== undefined;
  const style = sized ? ({ "--inspector-width": `${width}px` } as CSSProperties) : undefined;
  const widthClass = variant === "sheet" ? "" : sized ? "w-(--inspector-width)" : "w-inspector";
  return (
    <div
      ref={ref}
      role={role}
      aria-modal={ariaModal || undefined}
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      tabIndex={-1}
      style={style}
      className={`${SURFACE[variant]} ${widthClass}`}
    >
      {sized && onWidthChange && (
        <ResizeEdge width={width} onWidthChange={onWidthChange} label={resizeLabel} edgeOffset={variant === "floating" ? 8 : 0} />
      )}
      {children}
    </div>
  );
}

/** The drag/keyboard resize edge on a surface's left side (useResizablePanel). */
function ResizeEdge({
  width,
  onWidthChange,
  label,
  edgeOffset,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  label: string;
  edgeOffset: number;
}) {
  const { handleProps } = useResizablePanel({ width, onWidthChange, edgeOffset });
  return (
    <div
      {...handleProps}
      aria-label={label}
      title="Drag to resize"
      className="group absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize touch-none outline-none hover:bg-ink/20 focus-visible:bg-ink/20 active:bg-ink/20 max-sm:hidden"
    >
      <div className="absolute left-0 top-1/2 h-8 w-0.5 -translate-y-1/2 bg-line-strong opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

/**
 * Header row: an optional leading icon (or a Back button), the title with its
 * status beside it, a muted subtitle, actions, and close.
 */
export function InspectorHeader({
  titleId,
  title,
  subtitle,
  icon,
  status,
  actions,
  onClose,
  closeLabel = "Close",
  divider = false,
}: {
  titleId?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Without it there is no close button (the phone sheet has Back instead). */
  onClose?: () => void;
  closeLabel?: string;
  /** A bottom rule when no tabs follow the header. */
  divider?: boolean;
}) {
  return (
    <div className={`flex shrink-0 items-start gap-3 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] ${divider ? "border-b border-line" : ""}`}>
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id={titleId} className="min-w-0 truncate text-[15px] font-semibold leading-tight">
            {title}
          </h2>
          {status}
        </div>
        {subtitle && <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="-mr-1 shrink-0 rounded-field p-1.5 text-ink-3 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

/** Underline tabs: the selected tab gets an ink underline, the rest stay muted. */
export function InspectorTabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; dirty?: boolean }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 gap-4 border-b border-line px-4">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`-mb-px border-b-2 py-2 text-[13px] outline-none transition focus-visible:text-ink ${
              active ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink"
            }`}
          >
            {option.label}
            {option.dirty && <span aria-label="unsaved changes" className="ml-1 text-ink-3">•</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Padding wrapper for one tab's content. */
export function InspectorBody({ children }: { children: ReactNode }) {
  return <div className="grid flex-1 content-start gap-4 px-4 py-4">{children}</div>;
}

/** One field row: caption label above, the control on an inset block. */
export function InspectorField({
  label,
  htmlFor,
  hint,
  trailing,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  /** A small link or button on the caption line (e.g. "Reset"). */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-caption">
          {label}
        </label>
        {trailing}
      </div>
      <div className="rounded-field bg-inset p-2.5">{children}</div>
      {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

/** Control classes for inputs inside an InspectorField. */
export const INSPECTOR_INPUT =
  "w-full rounded-field border border-line bg-panel px-2.5 py-1.5 text-[13.5px] text-ink outline-none transition focus:border-ink-3 disabled:opacity-50";

/** Sticky footer: "Edited …" on the left, Discard and Save (ink) on the right. */
export function InspectorFooter({
  dirty,
  editedAt,
  saving,
  error,
  onDiscard,
  onSave,
  saveLabel = "Save",
  extra,
}: {
  dirty: boolean;
  editedAt: number | null;
  saving?: boolean;
  error?: string | null;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
  /** A quiet action on the left when nothing is edited (e.g. Save as template). */
  extra?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (editedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [editedAt]);
  const edited = dirty ? editedLabel(editedAt, now) : null;
  return (
    <div className="sticky bottom-0 mt-auto shrink-0 border-t border-line bg-panel px-4 py-3">
      {error && (
        <p role="alert" className="mb-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{edited ?? (dirty ? "Unsaved changes" : extra ?? "No changes")}</span>
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || saving}
          className="h-8 rounded-field border border-line px-3 text-[13px] text-ink-2 outline-none transition hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="h-8 rounded-field bg-ink px-3.5 text-[13px] font-medium text-canvas outline-none transition hover:bg-ink/85 focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
        >
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    </div>
  );
}
