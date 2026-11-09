import { TASK_INPUT_REFUSAL_COPY, type TaskInputRefusal } from "@/api/convex/lib/taskInputGuard";

/** The inline line for a steer/answer the backend input guard refused. */
export function refusalCopy(reason: string | undefined): string {
  if (reason && reason in TASK_INPUT_REFUSAL_COPY) return TASK_INPUT_REFUSAL_COPY[reason as TaskInputRefusal];
  if (reason === "empty_answer" || reason === "empty_instruction") return "Type something first.";
  return "That didn't reach the task. Try again in a moment.";
}
