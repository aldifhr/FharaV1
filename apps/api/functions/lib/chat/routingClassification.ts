/**
 * Structured owner routing: one validated JSON object from the small intent
 * classifier. Roles are the live enum from `lib/roles.ts`; nothing here reads
 * role names or domains out of free text.
 */
import { isRoleKey, type RoleKey } from "../roles";

export const ROUTING_KINDS = [
  "implementation",
  "verification",
  "research",
  "audit",
  "design",
  "devops",
  "conversation",
] as const;
export type RoutingKind = (typeof ROUTING_KINDS)[number];

export interface RoutingClassification {
  role: RoleKey | null;
  kind: RoutingKind;
  files: string[];
  confidence: number;
}

/** Below this the caller asks the user; it never guesses a role. */
export const ROUTING_MIN_CONFIDENCE = 0.7;
const MAX_FILES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict validation; null means the classifier output cannot be used. */
export function parseRoutingClassification(value: unknown): RoutingClassification | null {
  if (!isRecord(value)) return null;
  const rawRole = value.role;
  if (rawRole !== null && (typeof rawRole !== "string" || !isRoleKey(rawRole))) return null;
  if (typeof value.kind !== "string" || !ROUTING_KINDS.includes(value.kind as RoutingKind)) return null;
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) return null;
  const files: string[] = [];
  for (const file of value.files) {
    if (typeof file !== "string" || !file.trim() || file.length > 200) return null;
    if (!files.includes(file)) files.push(file);
  }
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return null;
  const confidence = Math.max(0, Math.min(1, value.confidence));
  return { role: rawRole as RoleKey | null, kind: value.kind as RoutingKind, files, confidence };
}

/** A classification is actionable only with a live role and enough confidence. */
export function actionableRouting(routing: RoutingClassification | undefined | null): RoutingClassification | null {
  if (!routing || routing.role === null || routing.confidence < ROUTING_MIN_CONFIDENCE) return null;
  return routing;
}
