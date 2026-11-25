import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClassifierEval } from "./harness";
import { CLASSIFIER_CASES } from "./classifier.cases";
import { EXTRA_CASES } from "./classifier.extra-cases";

/**
 * Regression gate for the intent classifier eval.
 *
 * Failures listed in baseline.json are KNOWN gaps (see classifier.cases.ts).
 * This test fails when
 *   - a case outside the baseline fails        -> regression, or a new case
 *     that exposes a gap: fix the classifier or add it to the baseline, and
 *   - a baseline case now passes               -> improvement: refresh with
 *     `pnpm --filter @fhara/worker eval:classifier --update-baseline` so the
 *     ratchet tightens.
 */
const baseline = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "baseline.json"), "utf8")
) as { knownFailures: string[] };

describe("classifier eval gate", () => {
  const report = runClassifierEval();
  const known = new Set(baseline.knownFailures);

  it("has no new failures beyond the baseline", () => {
    const fresh = report.failures.filter((f) => !known.has(f.id));
    expect(
      fresh.map((f) => `${f.id} ${JSON.stringify(f.command)}: ${f.mismatches.join("; ")}`)
    ).toEqual([]);
  });

  it("typo labels are limited to plain data files (.md/.txt/data)", () => {
    const cases = [...CLASSIFIER_CASES, ...EXTRA_CASES].filter((entry) => /typo/i.test(entry.command));
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      expect(entry.command).toMatch(/\.(md|txt|json|csv|ya?ml|toml|ini|cfg|conf|log|xml|sql|lock)\b/i);
    }
  });

  it("baseline lists only cases that still fail", () => {
    const stillFailing = new Set(report.failures.map((f) => f.id));
    const fixed = baseline.knownFailures.filter((id) => !stillFailing.has(id));
    expect(fixed, "now passing: re-run eval:classifier --update-baseline").toEqual([]);
  });
});
