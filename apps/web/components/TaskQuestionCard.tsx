import { ARCH_STOP_RESUME_ANSWER, heldStopReason } from "@/lib/systemLine";

/**
 * The question a waiting task asks, with its options (split out of TaskThreadPanel.tsx).
 * O4: a task the CTO stopped before its gated work (O2 holds it in waiting_input) shows the CTO's
 * reason with real Resume and Cancel actions instead: Resume answers the held question with the
 * resume option (tasks.answerQuestion via onAnswer); Cancel is the caller's ConfirmDialog (tasks.cancel).
 */
export default function TaskQuestionCard({
  task,
  busy,
  onAnswer,
  onCancel,
}: {
  task: { status?: string; pendingQuestion?: string | null; pendingOptions?: unknown };
  busy: boolean;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}) {
  if (task.status !== "waiting_input" || !task.pendingQuestion) return null;
  const held = heldStopReason(task);
  const options: string[] = held ? [] : Array.isArray(task.pendingOptions) ? task.pendingOptions : [];
  const action = "rounded-lg px-3 py-1.5 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50";
  return (
    <div className="rounded-xl border border-line bg-panel-2 p-3.5">
      <p className={`text-[13px] font-medium ${held ? "text-ink-2" : "text-warn"}`}>{held ? "Held · CTO stopped the plan" : "The team asked you"}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">{held ?? task.pendingQuestion}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {held && (
          <button type="button" disabled={busy} onClick={() => onAnswer(ARCH_STOP_RESUME_ANSWER)} className={`${action} border border-line bg-panel text-ink hover:bg-hover`}>
            Resume
          </button>
        )}
        {options.map((option, index) => (
          <button
            key={`${index}-${option}`}
            type="button"
            disabled={busy}
            onClick={() => onAnswer(option)}
            className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-1.5 text-left text-[14px] text-ink outline-none hover:border-brand/40 hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-hover text-[11px] font-semibold text-ink-2">{String.fromCharCode(65 + index)}</span>
            {option}
          </button>
        ))}
        <button type="button" disabled={held ? busy : false} onClick={onCancel} className={`${action} text-ink-2 hover:bg-hover hover:text-ink`}>
          {held ? "Cancel" : "Cancel task"}
        </button>
      </div>
    </div>
  );
}
