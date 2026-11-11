import type { HTMLAttributes, ReactNode } from "react";

/**
 * Card parts for the dashboard restyle (F5). A hairline card on bg-panel with
 * a header (kind caption above the title, right-hand slot for status and
 * actions), an optional inset body on bg-inset, and a footer of metric pairs
 * whose numbers are monospaced. Theme tokens only: no tinted fills, no
 * rounded-full tags; status goes in the header slot as a StatusTag.
 */

const join = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function PanelCard({
  selected = false,
  interactive = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { selected?: boolean; interactive?: boolean }) {
  return (
    <div
      {...rest}
      data-selected={selected || undefined}
      className={join(
        "overflow-hidden rounded-card border bg-panel text-ink",
        selected ? "border-ink/30" : "border-line",
        interactive && "cursor-pointer outline-none transition-colors hover:border-ink/30 focus-visible:ring-2 focus-visible:ring-ink/30",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PanelCardHeader({
  kind,
  title,
  icon,
  meta,
  aside,
  className,
}: {
  /** Small uppercase caption above the title ("Task", a phase, a lane). */
  kind?: ReactNode;
  title: ReactNode;
  icon?: ReactNode;
  /** One quiet line under the title. */
  meta?: ReactNode;
  /** Right-hand slot: a StatusTag, icon buttons, an arrow. */
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={join("flex items-start gap-2.5 px-3.5 pb-2.5 pt-3", className)}>
      {icon ? <span className="mt-0.5 flex shrink-0 items-center">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        {kind ? <p className="text-caption truncate">{kind}</p> : null}
        <div className="truncate text-sm font-semibold leading-snug text-ink">{title}</div>
        {meta ? <div className="mt-1 min-w-0 text-[12px] leading-normal text-ink-3">{meta}</div> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-1.5">{aside}</div> : null}
    </div>
  );
}

export function PanelCardBody({
  caption,
  children,
  className,
}: {
  caption?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={join("mx-3.5 mb-3 rounded-field bg-inset px-3 py-2.5", className)}>
      {caption ? <p className="text-caption mb-1.5">{caption}</p> : null}
      {children}
    </div>
  );
}

export type PanelMetric = { label: string; value: ReactNode; title?: string };

export function PanelCardFooter({
  metrics,
  children,
  className,
}: {
  metrics?: PanelMetric[];
  /** Extra content on the right (assignees, a link). */
  children?: ReactNode;
  className?: string;
}) {
  const shown = (metrics ?? []).filter((m) => m.value !== null && m.value !== undefined && m.value !== "");
  if (!shown.length && !children) return null;
  return (
    <div className={join("flex flex-wrap items-end gap-x-5 gap-y-2 border-t border-line px-3.5 py-2.5", className)}>
      {shown.map((m) => (
        <div key={m.label} className="min-w-0" title={m.title}>
          <p className="text-caption">{m.label}</p>
          <p className="max-w-[16rem] truncate font-mono text-[12.5px] leading-5 tabular-nums text-ink">{m.value}</p>
        </div>
      ))}
      {children ? <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}
