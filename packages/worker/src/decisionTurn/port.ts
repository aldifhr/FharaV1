/**
 * GOAT G13: the worker's side of apps/api/convex/decisionTurns.ts, through
 * the WorkerApi client (its `args()` adds the service token). An interface
 * so the runner tests can inject a fake.
 */
import { wenv } from "@fhara/config/worker";
import { api } from "@/api/convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { WorkerApi } from "@/workerApi";

type Args<F extends Parameters<WorkerApi["client"]["mutation"]>[0]> = Omit<FunctionArgs<F>, "workerToken">;
type Relaxed<T> = { [K in keyof T]: T[K] extends string & { __tableName: string } ? string : T[K] };

export type OpenTurnResult = FunctionReturnType<typeof api.decisionTurns.open>;
export type ClaimedTurn = NonNullable<FunctionReturnType<typeof api.decisionTurns.claimNext>>;

export interface DecisionTurnPort {
  open(input: Relaxed<Args<typeof api.decisionTurns.open>>): Promise<OpenTurnResult>;
  answer(input: Relaxed<Args<typeof api.decisionTurns.answer>>): Promise<FunctionReturnType<typeof api.decisionTurns.answer>>;
  expire(input: Relaxed<Args<typeof api.decisionTurns.expire>>): Promise<unknown>;
  consume(input: Relaxed<Args<typeof api.decisionTurns.consume>>): Promise<unknown>;
  claimNext(input: Args<typeof api.decisionTurns.claimNext>): Promise<ClaimedTurn | null>;
}

export function convexDecisionTurnPort(workerApi: WorkerApi): DecisionTurnPort {
  const call = (fn: Parameters<WorkerApi["client"]["mutation"]>[0], input: object) =>
    workerApi.client.mutation(fn, workerApi.args(input as Record<string, unknown>));
  return {
    open: (input) => call(api.decisionTurns.open, input),
    answer: (input) => call(api.decisionTurns.answer, input),
    expire: (input) => call(api.decisionTurns.expire, input),
    consume: (input) => call(api.decisionTurns.consume, input),
    claimNext: (input) => call(api.decisionTurns.claimNext, input),
  };
}

/** The CTO-first setting (@fhara/config): off, or on with the turn's deadline. */
export interface CtoFirstConfig {
  enabled: boolean;
  ttlMs: number;
}

export function ctoFirstFromEnv(): CtoFirstConfig {
  return { enabled: wenv("FHARA_CTO_QUESTIONS"), ttlMs: wenv("FHARA_CTO_QUESTION_TTL_MS") };
}
