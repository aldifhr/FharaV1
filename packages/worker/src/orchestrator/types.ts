// Domain types live in `@/types` (split by domain); this module stays a
// stable import path for the orchestrator and its tests.
export { CAPABILITY } from "@/types/plan";
export type { Capability, ExecutionPlan, Classification, Concern } from "@/types/plan";
export type { SubtaskKind, PlanSubtask, DynamicSubtaskOrigin } from "@/types/subtask";
export type { AgentDefinition, AgentStatus } from "@/types/agent";
export type { TaskContext } from "@/types/task";
