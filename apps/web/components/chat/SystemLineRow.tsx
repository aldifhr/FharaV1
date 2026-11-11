import { SYSTEM_LABEL } from "@/lib/systemLine";

/**
 * O4: one muted status row for a System line ("Sent to Backend", "Planned 3 subtasks").
 * Neutral label, no avatar, no @name, no actions: it is not a reply target.
 */
export default function SystemLineRow({ id, text, time, className = "" }: { id?: string; text: string; time?: string; className?: string }) {
  return (
    <div id={id} className={`flex items-baseline gap-2 border-t border-line pt-2 text-[12px] text-ink-3 ${className}`}>
      <span className="shrink-0 font-medium text-ink-2">{SYSTEM_LABEL}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
      {time && <span className="shrink-0">{time}</span>}
    </div>
  );
}
