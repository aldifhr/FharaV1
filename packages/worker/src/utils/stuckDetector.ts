/**
 * Stuck detection for the bounded tool loops (R10).
 *
 * Copied from OpenHands/software-agent-sdk,
 * clients/typescript/src/conversation/stuck-detector.ts (shallow clone of
 * 2026-11-11): the four patterns (action-observation loop, action-error loop,
 * monologue, alternating A-B-A-B) and their default thresholds 4/4/4/6.
 * SPDX-License-Identifier: MIT. Copyright (c) 2025 OpenHands.
 *
 * Modified by Fhara: the SDK event types are replaced by a minimal local
 * event union for the worker's JSON tool loop (`tools/toolLoop.ts`);
 * equality compares tool name + JSON arguments / result text; the
 * context-window pattern and condensation events are dropped (the loop has
 * neither). The control flow of `isStuck` and each check is unchanged.
 * See THIRD_PARTY_NOTICES.md.
 */

/** One step of a tool loop, as the detector sees it. */
export type StuckEvent =
  | { kind: "user_message"; text: string }
  | { kind: "agent_message"; text: string }
  | { kind: "action"; tool: string; args: string }
  | { kind: "observation"; tool: string; text: string }
  | { kind: "error"; tool: string; error: string };

type ActionEvent = Extract<StuckEvent, { kind: "action" }>;
type ObservationEvent = Extract<StuckEvent, { kind: "observation" }>;
type AgentErrorEvent = Extract<StuckEvent, { kind: "error" }>;

const isActionEvent = (e: StuckEvent): e is ActionEvent => e.kind === "action";
const isObservationEvent = (e: StuckEvent): e is ObservationEvent => e.kind === "observation";
const isAgentErrorEvent = (e: StuckEvent): e is AgentErrorEvent => e.kind === "error";
const isMessageEvent = (e: StuckEvent): e is Extract<StuckEvent, { kind: "user_message" | "agent_message" }> =>
  e.kind === "user_message" || e.kind === "agent_message";

export interface StuckDetectionThresholds {
  /** Identical action-observation pairs before triggering (default 4). */
  actionObservation: number;
  /** Identical action-error pairs before triggering (default 4). */
  actionError: number;
  /** Consecutive agent messages without user input (default 4). */
  monologue: number;
  /** Alternating patterns before triggering (default 6). */
  alternatingPattern: number;
}

export const DEFAULT_STUCK_THRESHOLDS: StuckDetectionThresholds = {
  actionObservation: 4,
  actionError: 4,
  monologue: 4,
  alternatingPattern: 6,
};

export type StuckPattern = "action_observation_loop" | "action_error_loop" | "monologue" | "alternating_pattern";

export interface StuckDetectionResult {
  isStuck: boolean;
  pattern?: StuckPattern;
  repetitions?: number;
  description?: string;
}

export class StuckDetector {
  private thresholds: StuckDetectionThresholds;

  constructor(thresholds?: Partial<StuckDetectionThresholds>) {
    this.thresholds = { ...DEFAULT_STUCK_THRESHOLDS, ...thresholds };
  }

  isStuck(events: StuckEvent[]): StuckDetectionResult {
    const lastUserMsgIndex = this.findLastUserMessageIndex(events);
    if (lastUserMsgIndex === -1) return { isStuck: false };
    const recentEvents = events.slice(lastUserMsgIndex + 1);
    const minThreshold = Math.min(this.thresholds.actionObservation, this.thresholds.actionError, this.thresholds.monologue);
    if (recentEvents.length < minThreshold) return { isStuck: false };

    const maxNeeded = Math.max(this.thresholds.actionObservation, this.thresholds.actionError);
    const lastActions: ActionEvent[] = [];
    const lastObservations: (ObservationEvent | AgentErrorEvent)[] = [];
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const event = recentEvents[i];
      if (isActionEvent(event) && lastActions.length < maxNeeded) {
        lastActions.push(event);
      } else if ((isObservationEvent(event) || isAgentErrorEvent(event)) && lastObservations.length < maxNeeded) {
        lastObservations.push(event);
      }
      if (lastActions.length >= maxNeeded && lastObservations.length >= maxNeeded) break;
    }

    const actionObsResult = this.checkRepeatingActionObservation(lastActions, lastObservations);
    if (actionObsResult.isStuck) return actionObsResult;
    const actionErrorResult = this.checkRepeatingActionError(lastActions, lastObservations);
    if (actionErrorResult.isStuck) return actionErrorResult;
    const monologueResult = this.checkMonologue(recentEvents);
    if (monologueResult.isStuck) return monologueResult;
    if (recentEvents.length >= this.thresholds.alternatingPattern) {
      const alternatingResult = this.checkAlternatingPattern(recentEvents);
      if (alternatingResult.isStuck) return alternatingResult;
    }
    return { isStuck: false };
  }

  private findLastUserMessageIndex(events: StuckEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === "user_message") return i;
    }
    return -1;
  }

  private checkRepeatingActionObservation(
    lastActions: ActionEvent[],
    lastObservations: (ObservationEvent | AgentErrorEvent)[]
  ): StuckDetectionResult {
    const threshold = this.thresholds.actionObservation;
    if (lastActions.length < threshold || lastObservations.length < threshold) return { isStuck: false };
    const observations = lastObservations.filter(isObservationEvent);
    if (observations.length < threshold) return { isStuck: false };
    const actionsEqual = lastActions.slice(0, threshold).every((action) => this.actionsEqual(lastActions[0], action));
    const observationsEqual = observations.slice(0, threshold).every((obs) => this.observationsEqual(observations[0], obs));
    if (actionsEqual && observationsEqual) {
      return {
        isStuck: true,
        pattern: "action_observation_loop",
        repetitions: threshold,
        description: `Agent is repeating the same action-observation cycle ${threshold} times. Action: ${lastActions[0].tool}`,
      };
    }
    return { isStuck: false };
  }

  private checkRepeatingActionError(
    lastActions: ActionEvent[],
    lastObservations: (ObservationEvent | AgentErrorEvent)[]
  ): StuckDetectionResult {
    const threshold = this.thresholds.actionError;
    if (lastActions.length < threshold || lastObservations.length < threshold) return { isStuck: false };
    const actionsEqual = lastActions.slice(0, threshold).every((action) => this.actionsEqual(lastActions[0], action));
    if (!actionsEqual) return { isStuck: false };
    const allErrors = lastObservations.slice(0, threshold).every(isAgentErrorEvent);
    if (allErrors) {
      return {
        isStuck: true,
        pattern: "action_error_loop",
        repetitions: threshold,
        description: `Agent is repeating the same action ${threshold} times and getting errors. Action: ${lastActions[0].tool}`,
      };
    }
    return { isStuck: false };
  }

  private checkMonologue(events: StuckEvent[]): StuckDetectionResult {
    const threshold = this.thresholds.monologue;
    if (events.length < threshold) return { isStuck: false };
    let agentMessageCount = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (isMessageEvent(event)) {
        if (event.kind === "agent_message") agentMessageCount++;
        else break;
      } else {
        break;
      }
    }
    if (agentMessageCount >= threshold) {
      return {
        isStuck: true,
        pattern: "monologue",
        repetitions: agentMessageCount,
        description: `Agent has sent ${agentMessageCount} consecutive messages without user input`,
      };
    }
    return { isStuck: false };
  }

  private checkAlternatingPattern(events: StuckEvent[]): StuckDetectionResult {
    const threshold = this.thresholds.alternatingPattern;
    const lastActions: ActionEvent[] = [];
    const lastObservations: (ObservationEvent | AgentErrorEvent)[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (isActionEvent(event) && lastActions.length < threshold) {
        lastActions.push(event);
      } else if ((isObservationEvent(event) || isAgentErrorEvent(event)) && lastObservations.length < threshold) {
        lastObservations.push(event);
      }
      if (lastActions.length === threshold && lastObservations.length === threshold) break;
    }
    if (lastActions.length < threshold || lastObservations.length < threshold) return { isStuck: false };
    const actionsAlternate = this.checkAlternatingEquality(lastActions);
    const observationsAlternate = this.checkAlternatingEquality(lastObservations);
    if (actionsAlternate && observationsAlternate) {
      return {
        isStuck: true,
        pattern: "alternating_pattern",
        repetitions: threshold,
        description: "Agent is stuck in an alternating action-observation pattern",
      };
    }
    return { isStuck: false };
  }

  private checkAlternatingEquality<T extends StuckEvent>(items: T[]): boolean {
    if (items.length < 4) return false;
    for (let i = 0; i < items.length - 2; i++) {
      if (!this.eventsEqual(items[i], items[i + 2])) return false;
    }
    return true;
  }

  private actionsEqual(a: ActionEvent, b: ActionEvent): boolean {
    return a.tool === b.tool && a.args === b.args;
  }

  private observationsEqual(a: ObservationEvent, b: ObservationEvent): boolean {
    return a.tool === b.tool && a.text === b.text;
  }

  private eventsEqual(a: StuckEvent, b: StuckEvent): boolean {
    if (a.kind !== b.kind) return false;
    if (isActionEvent(a) && isActionEvent(b)) return this.actionsEqual(a, b);
    if (isObservationEvent(a) && isObservationEvent(b)) return this.observationsEqual(a, b);
    if (isAgentErrorEvent(a) && isAgentErrorEvent(b)) return a.tool === b.tool && a.error === b.error;
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
