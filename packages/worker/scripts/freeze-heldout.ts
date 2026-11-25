/**
 * Freeze a stratified held-out id list (plan 085). Run once before tuning;
 * never tune on these cases or use them as few-shot examples.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CLASSIFIER_CASES } from "../tests/eval/classifier.cases";
import { EXTRA_CASES } from "../tests/eval/classifier.extra-cases";

const cases = [...CLASSIFIER_CASES, ...EXTRA_CASES];
const groups = new Map<string, string[]>();
for (const entry of cases) {
  const key = `${entry.expect.kind}:${entry.lang}`;
  const list = groups.get(key) ?? [];
  list.push(entry.id);
  groups.set(key, list);
}
const heldOut: string[] = [];
for (const [key, ids] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  ids.sort();
  if (ids.length === 2) heldOut.push(ids[1]!);
  else for (let i = 2; i < ids.length; i += 3) heldOut.push(ids[i]!);
  if (!heldOut.some((id) => ids.includes(id)) && ids.length > 1) heldOut.push(ids[0]!);
}
const file = path.resolve(import.meta.dirname, "../tests/eval/held-out.json");
writeFileSync(file, `${JSON.stringify({ heldOut: [...new Set(heldOut)].sort() }, null, 2)}\n`);
console.log(`froze ${new Set(heldOut).size} held-out ids across ${groups.size} strata -> ${file}`);
