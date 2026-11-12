"use client";

import { KnobSelect } from "./controls";

/** ORCHESTRATOR_WORKTREE_ISOLATION: auto (per task), always, never (L3). */
export function IsolationKnob() {
  return (
    <KnobSelect
      knob="ORCHESTRATOR_WORKTREE_ISOLATION"
      label="Isolate tasks in worktrees"
      description={
        <>
          Auto: each task gets its own worktree and runs steps in parallel when the folder is a clean git checkout
          with a commit and the backend runs on this machine or is self-hosted; otherwise steps run one at a time in the
          folder. Unset uses <code className="font-mono">ORCHESTRATOR_WORKTREE_ISOLATION</code> from the worker env (auto).
          Applies to the next task, no restart.
        </>
      }
      options={[
        { value: "auto", label: "Auto" },
        { value: "true", label: "Always" },
        { value: "false", label: "Never" },
      ]}
    />
  );
}
