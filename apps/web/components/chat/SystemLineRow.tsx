/**
 * O4: one muted, centered status line for a System line ("Sent to Backend", "Planned 3 subtasks").
 * No label, no avatar, no @name, no actions: it is not a reply target. The full text and the time
 * sit in the tooltip when the line is cut.
 */
export default function SystemLineRow({ id, text, time, className = "" }: { id?: string; text: string; time?: string; className?: string }) {
  return (
    <p id={id} title={time ? `${text}\n${time}` : text} className={`truncate px-4 text-center text-[13px] text-ink-3 ${className}`}>
      {text}
    </p>
  );
}
