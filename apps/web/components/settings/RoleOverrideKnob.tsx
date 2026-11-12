"use client";

import { KnobToggle } from "./controls";

/**
 * FHARA_LLM_ROLE_OVERRIDE (L4), under the model list in Settings → LLM & Models.
 * Off (default): every call uses the one model list. On: a project's model per
 * role (Manage project → Model per role) goes first, the list is the fallback.
 */
export function RoleOverrideKnob() {
  return (
    <section className="grid gap-2" aria-labelledby="llm-role-override">
      <h3 id="llm-role-override" className="text-[13px] font-medium text-ink-2">
        Per-role override
      </h3>
      <KnobToggle
        knob="FHARA_LLM_ROLE_OVERRIDE"
        label="Model per role"
        description="Off: every call (planner, workers, reviewer, chat) uses the list above. On: a project's model for each role, set in Manage project, goes first and the list is the fallback."
      />
    </section>
  );
}
