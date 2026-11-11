import { test } from "node:test";
import assert from "node:assert/strict";
import { prefillPromptForRole, roleTemplateFor } from "../../../api/convex/lib/prompts/roleTemplate.ts";
import { ROLE_PROMPT_TEMPLATES } from "../../../api/convex/lib/prompts/rolePrompts.data.ts";

test("picking a role in the create form prefills its role template", () => {
  assert.equal(prefillPromptForRole("", "designer"), ROLE_PROMPT_TEMPLATES.designer);
  assert.equal(roleTemplateFor("backend"), ROLE_PROMPT_TEMPLATES.backend);
});

test("switching roles swaps an untouched template but keeps typed instructions", () => {
  assert.equal(prefillPromptForRole(ROLE_PROMPT_TEMPLATES.designer, "qa"), ROLE_PROMPT_TEMPLATES.qa);
  assert.equal(prefillPromptForRole("Only review SQL.", "qa"), "Only review SQL.");
  assert.equal(prefillPromptForRole(ROLE_PROMPT_TEMPLATES.qa, null), "");
});

test("a custom role has no template", () => {
  assert.equal(roleTemplateFor("data-wrangler"), null);
  assert.equal(prefillPromptForRole("", "data-wrangler"), "");
});
