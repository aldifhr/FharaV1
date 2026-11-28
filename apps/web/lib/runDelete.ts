/** Runs that can be sent to tasks.remove; running runs are refused by the backend. */
export function deletableRuns(runs: readonly { taskId: string; status: string }[]) {
  return runs.filter((r) => r.status !== "running");
}

export function deleteAllCopy(count: number, skipped: number): { title: string; message: string; confirmLabel: string } {
  const noun = count === 1 ? "run" : "runs";
  return {
    title: `Delete ${count} ${noun}?`,
    message: `${skipped > 0 ? `${skipped} still running ${skipped === 1 ? "run is" : "runs are"} skipped. ` : ""}This deletes the ${noun} and their task data. Audit history is kept.`,
    confirmLabel: `Delete ${count} ${noun}`,
  };
}
