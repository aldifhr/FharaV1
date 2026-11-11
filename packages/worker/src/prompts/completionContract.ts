// Adapted from GOAT (https://github.com/goat-si/goat) packages/provider-core/src/server/developmentInstructions.ts @ 718f5b11,
// MIT License, Copyright (c) 2026 T3 Tools Inc. and goat-si contributors. See THIRD_PARTY_NOTICES.md.
// Modified by Fhara: reworded for Fhara's runtime (pipeline answers, direct threads, permission modes).

/**
 * The completion contract every code-writing prompt carries (code_change,
 * native provider) and every direct-thread preamble: the criteria for
 * "done". Kept to a few lines because it rides on every call; the longer
 * guidance (work classes, verification floors) is the `fhara-discipline`
 * built-in skill attached to the Frontend, Backend and DevOps roles.
 */
export const COMPLETION_CONTRACT_LINES: readonly string[] = [
  "Completion contract:",
  "- Claim only what evidence on the current code shows: checks you ran now with zero failures, the symptom gone, a test that failed before the fix. Never weaken, skip or rewrite a check to make it pass. Name each check you did not run on a `NOT RUN:` line (a findings entry when you answer in JSON).",
  "- No placeholders, stubs presented as working, or fallbacks that hide a failure (a default where an error belongs, a catch that logs and continues).",
  "- Deleting what you did not create, dropping or resetting data, pushing and merging wait for the user's approval through Fhara.",
];

export const COMPLETION_CONTRACT = COMPLETION_CONTRACT_LINES.join("\n");
