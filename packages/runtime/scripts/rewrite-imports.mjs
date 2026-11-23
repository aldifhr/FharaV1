import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const roots = [
  path.join(root, "apps", "api", "runtime"),
  path.join(root, "apps", "web"),
  path.join(root, "packages", "worker"),
];

const replacements = [
  ["runtime/values", "@fhara/runtime/values"],
  ["runtime/server", "@fhara/runtime/server"],
  ["runtime/react", "@fhara/runtime/react"],
  ["runtime/browser", "@fhara/runtime/browser"],
  ["@/api/functions/_generated/api", "@fhara/runtime/api"],
  ["@/api/functions/_generated/dataModel", "@fhara/runtime/data"],
  ["@/api/functions/_generated/server", "@fhara/runtime/functions"],
];

const relativeGenerated = [
  [/["'](?:\.\.?\/)*_generated\/server(?:\.js)?["']/g, '"@fhara/runtime/functions"'],
  [/["'](?:\.\.?\/)*_generated\/api(?:\.js)?["']/g, '"@fhara/runtime/api"'],
  [/["'](?:\.\.?\/)*_generated\/dataModel(?:\.js)?["']/g, '"@fhara/runtime/data"'],
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name === "_generated") continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.(ts|tsx)$/.test(entry.name)) rewrite(target);
  }
}

function rewrite(file) {
  const before = fs.readFileSync(file, "utf8");
  let after = before;
  for (const [from, to] of replacements) {
    after = after.split(`"${from}"`).join(`"${to}"`);
    after = after.split(`'${from}'`).join(`"${to}"`);
  }
  for (const [pattern, value] of relativeGenerated) after = after.replace(pattern, value);
  if (after !== before) {
    fs.writeFileSync(file, after, "utf8");
    changed.push(path.relative(root, file));
  }
}

const changed = [];
for (const target of roots) if (fs.existsSync(target)) walk(target);
console.log(`[local] rewrote imports in ${changed.length} files`);
for (const file of changed.slice(0, 12)) console.log(`  ${file}`);
