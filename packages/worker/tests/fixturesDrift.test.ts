import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAll } from "../../../scripts/fixtures/make-synthetic.mjs";

/**
 * The committed fixtures (fixtures/scenarios) are exactly what the
 * generator writes: run `npm run fixtures:make` after changing it. Their
 * validity against the Convex schema is checked by
 * apps/api/convex/devFixtures.test.ts (it seeds every one).
 */
const ROOT = path.resolve(import.meta.dirname, "../../../fixtures/scenarios");

describe("fixtures (generator drift)", () => {
  const built = buildAll();

  it("one directory per generated scenario, nothing else", () => {
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(dirs).toEqual(built.map((b) => b.scenario.id).sort());
  });

  it.each(built.map((b) => [b.scenario.id, b] as const))("%s is up to date", (id, b) => {
    const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, id, "scenario.json"), "utf8"));
    const events = fs.readFileSync(path.join(ROOT, id, "events.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(scenario).toEqual(b.scenario);
    expect(events).toEqual(b.events);
  });

  it("is deterministic and commit-safe", () => {
    expect(JSON.stringify(buildAll())).toBe(JSON.stringify(built));
    const text = JSON.stringify(built);
    // No real secrets or machine paths: tokens, keys and home dirs never appear.
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|\/Users\/|\/home\/|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
