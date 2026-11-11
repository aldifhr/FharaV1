// Paradev C1 drift test: the composer's slash commands and ChatPanel's
// runSlash stay in step with the shared registry
// (apps/api/convex/lib/slashCommands.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FHARA_BUILTIN_COMMANDS } from "../../../api/convex/lib/slashCommands.ts";
import { personalSlashNames } from "../../lib/personalChat.ts";

// Registry builtins runSlash does not handle in the client: /research goes to
// the server as a message (intent.ts turns it into a task); /memory is wired
// in Paradev C3. C3 should shrink this set to just "research".
const NOT_IN_RUN_SLASH = new Set(["research", "memory"]);

test("runSlash handles exactly the registry builtins it owns", () => {
  const src = readFileSync(new URL("../../components/ChatPanel.tsx", import.meta.url), "utf8");
  const m = src.match(/const runSlash[\s\S]*?text\.match\(\/\^\\\/\(([a-z|]+)\)/);
  assert.ok(m, "runSlash's command regex not found in ChatPanel.tsx");
  const handled = new Set(m[1].split("|"));
  const registry = FHARA_BUILTIN_COMMANDS.map((c) => c.name);
  for (const name of handled) assert.ok(registry.includes(name), `runSlash handles /${name}, which is not in the registry`);
  assert.deepEqual(
    registry.filter((n) => !handled.has(n)).sort(),
    [...NOT_IN_RUN_SLASH].sort(),
    "registry builtins not handled by runSlash changed; update runSlash or NOT_IN_RUN_SLASH",
  );
});

test("personal chat slash names come from the registry's personal scope", () => {
  assert.deepEqual(personalSlashNames(false), []);
  assert.deepEqual(personalSlashNames(true), ["task"]);
});
