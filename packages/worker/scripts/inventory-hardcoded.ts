/**
 * Inventory of hardcoded decision logic in packages/worker/src.
 *
 *   pnpm --filter @fhara/worker inventory:hardcoded
 *   pnpm --filter @fhara/worker inventory:hardcoded --json
 *   pnpm --filter @fhara/worker inventory:hardcoded --details=intent
 *
 * Finds (via the TypeScript AST, not grep):
 *   regex     RegExp literals and `new RegExp(...)`
 *   wordlist  array literals of >= 5 plain strings
 *   const     top-level UPPER_SNAKE numeric constants
 *
 * Each file is mapped to a category by CATEGORY_RULES below. The mapping is a
 * judgement call: edit the rules, not the findings.
 *   safety   keep hardcoded (invariants, sandbox, allowlists, budget vetoes)
 *   intent   candidate for LLM-propose / code-validate
 *   config   candidate for typed config with per-project override
 *   other    parsing / formatting / protocol plumbing, not decision logic
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type Category = "safety" | "intent" | "config" | "other";
type Kind = "regex" | "wordlist" | "const";

interface Finding {
  file: string;
  line: number;
  kind: Kind;
  category: Category;
  size: number;
  snippet: string;
}

const SRC = path.resolve(import.meta.dirname, "../src");

const CATEGORY_RULES: Array<{ category: Category; test: RegExp }> = [
  { category: "safety", test: /(commandAllowlist|sandbox|urlGuard|planValidation|isolationPolicy|shellExportPolicy|osSandbox|budget|policy|approval|noTargetGuard|repeatGuard|accessLog)/i },
  { category: "intent", test: /(orchestrator\/(classifier|concernSplit|architecture|planningHint|responseOwner|planRouting|decision)|agentCapabilities|qaIntent|capabilities|roles|delegation|replanIntelligence)/i },
  { category: "config", test: /(scheduler\/|services\/runner\/(setup|execute|continuation|checkpoints)|timeouts?|limits?)/i },
];

function categorize(rel: string): Category {
  for (const rule of CATEGORY_RULES) if (rule.test.test(rel)) return rule.category;
  return "other";
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__golden__") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.gen\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function scan(file: string): Finding[] {
  const rel = path.relative(SRC, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const category = categorize(rel);
  const found: Finding[] = [];
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const snip = (node: ts.Node) => node.getText(sf).replace(/\s+/g, " ").slice(0, 80);

  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      found.push({ file: rel, line: line(node), kind: "regex", category, size: node.getText(sf).length, snippet: snip(node) });
    } else if (ts.isNewExpression(node) && node.expression.getText(sf) === "RegExp") {
      found.push({ file: rel, line: line(node), kind: "regex", category, size: node.getText(sf).length, snippet: snip(node) });
    } else if (ts.isArrayLiteralExpression(node) && node.elements.length >= 5 && node.elements.every((e) => ts.isStringLiteralLike(e))) {
      found.push({ file: rel, line: line(node), kind: "wordlist", category, size: node.elements.length, snippet: snip(node) });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /^[A-Z][A-Z0-9_]{2,}$/.test(node.name.text) &&
      node.initializer &&
      ts.isNumericLiteral(node.initializer) &&
      ts.isVariableStatement(node.parent.parent) &&
      node.parent.parent.parent === sf
    ) {
      found.push({ file: rel, line: line(node), kind: "const", category, size: 1, snippet: snip(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const args = process.argv.slice(2);
const detailsArg = args.find((a) => a.startsWith("--details="))?.split("=")[1] as Category | undefined;
const findings = walk(SRC).flatMap(scan);

if (args.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

const categories: Category[] = ["safety", "intent", "config", "other"];
const kinds: Kind[] = ["regex", "wordlist", "const"];
const count = (category: Category, kind: Kind) => findings.filter((f) => f.category === category && f.kind === kind).length;

console.log("Hardcoded inventory (packages/worker/src, tests excluded)\n");
console.log("| category | regex | wordlist | const | total | action |");
console.log("|---|---:|---:|---:|---:|---|");
const action: Record<Category, string> = {
  safety: "keep hardcoded",
  intent: "LLM proposes, code validates",
  config: "typed config + per-project override",
  other: "parsing/plumbing, ignore",
};
for (const category of categories) {
  const row = kinds.map((kind) => count(category, kind));
  console.log(`| ${category} | ${row.join(" | ")} | ${row.reduce((a, b) => a + b, 0)} | ${action[category]} |`);
}

for (const category of detailsArg ? [detailsArg] : (["intent", "config"] as Category[])) {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings.filter((x) => x.category === category)) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, detailsArg ? 40 : 10);
  console.log(`\nTop files: ${category}`);
  for (const [file, list] of ranked) {
    const r = list.filter((x) => x.kind === "regex").length;
    const w = list.filter((x) => x.kind === "wordlist").length;
    const c = list.filter((x) => x.kind === "const").length;
    console.log(`  ${String(list.length).padStart(3)}  ${file}  (regex ${r}, wordlist ${w}, const ${c})`);
  }
}
