/**
 * The planning prompt's routing hint block (P1a). Lives in prompts/ (layer 0)
 * so the planner prompt can use it; orchestrator/planningHint.ts re-exports
 * it. The hint type is structural here (RoutingHint from
 * api/convex/lib/routingHint is assignable) to keep Convex validators out
 * of the foundation layer.
 */
import { ROLES } from "@/api/convex/lib/roles";

/** The fields of a routing hint the prompt block reads. */
export interface RoutingHintFacts {
  source?: string;
  role?: string;
  domain?: string;
  topic?: string;
  kind?: string;
  brief?: string;
  files?: string[];
  hard?: boolean;
}

/** The planning prompt's hint block (task part of the prompt). Empty without a hint. */
export function routingHintPromptLines(hint: RoutingHintFacts | null | undefined): string[] {
  if (!hint) return [];
  const facts = [
    hint.role ? `owner role: ${ROLES[hint.role as keyof typeof ROLES]?.label ?? hint.role}` : "",
    hint.kind ? `intent: ${hint.kind}` : "",
    hint.domain ? `domain: ${hint.domain}` : "",
    hint.topic ? `topic: ${hint.topic}` : "",
    hint.files?.length ? `files named: ${hint.files.join(", ")}` : "",
    hint.brief ? `plan line: ${hint.brief}` : "",
  ].filter(Boolean);
  if (facts.length === 0) return [];
  return [
    "",
    hint.hard
      ? "Routing hint (the user @mentioned this owner: route the implementing work to it):"
      : "Routing hint (from chat; a prior, override it when the request clearly needs another owner):",
    ...facts.map((fact) => `- ${fact}`),
  ];
}
