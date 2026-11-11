// Adapted from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness, MIT, Copyright (c) 2026 DeepSeek),
// commit e8f7b93a, packages/goal/goal-round-driver/src/prompt.ts and packages/goal/tool-goal/src/wrapup.ts.
// Modified by Fhara: plain strings instead of ContentBlock[]; the goal is Fhara's DirectGoal (`maxRounds`);
// "read the current goal, and mark it complete" / "the configured goal-tool policy" became the reply-marker
// rule passed in by the caller (direct threads have no goal tool yet); Prettier style. See THIRD_PARTY_NOTICES.md
// ("DeepSeek Harness").

/** Model-visible continuation prompt for one same-session goal round. */
export function renderGoalRoundPrompt(goal: { objective: string; maxRounds: number }, round: number, markerRule: string): string {
  return (
    "<goal_round>\n" +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${goal.maxRounds}\n\n` +
    "Continue working toward the objective in this same session. Treat the current workspace, " +
    "tool results, and durable session state as authoritative; inspect them instead of assuming " +
    "earlier narration is still current. Make concrete progress and verify the result. Before " +
    "claiming completion, gather evidence that the whole objective is achieved. If work remains, " +
    "leave the goal active for the next round. " +
    markerRule +
    "\n</goal_round>"
  );
}

const GROUNDING =
  "Report only what earlier rounds and tool results in this session actually establish; " +
  "when a detail is not in the session, say so instead of inventing it. ";

/**
 * The closing-message instruction after a goal round reports `complete` or
 * `blocked` (or runs out of rounds): one message to the user, no more tools.
 */
export function renderWrapupPrompt(objective: string, blockedReason?: string): string {
  const heading = `Objective: ${JSON.stringify(objective)}\n`;
  return blockedReason === undefined
    ? "<goal_complete>\n" +
        heading +
        "The goal is marked complete and this autonomous run is ending. Write the closing " +
        "message to the user now: state the outcome, summarize what was done and how it was " +
        "verified, and point to the concrete results (files, commits, or other artifacts). " +
        GROUNDING +
        "Note anything the user should review or do next. Address the user directly. Do not " +
        "call any more tools in this run; further work waits for the user's next instruction.\n" +
        "</goal_complete>"
    : "<goal_blocked>\n" +
        heading +
        `Blocked: ${JSON.stringify(blockedReason)}\n` +
        "The goal is marked blocked and this autonomous run is ending. Write the closing " +
        "message to the user now: state what has been completed so far, describe the concrete " +
        "blocking condition and what you tried, and say exactly what you need from the user to " +
        "continue. " +
        GROUNDING +
        "Address the user directly. Do not call any more tools in this run; further work " +
        "waits for the user's next instruction.\n" +
        "</goal_blocked>";
}
