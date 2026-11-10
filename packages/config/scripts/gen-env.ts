/**
 * `npm run env:example`: regenerate the files derived from the schema.
 *   .env.example                        (the one documented env file)
 *   apps/api/.env.example               (Convex CLI target only)
 *   packages/config/env-manifest.json   (plain-node consumers)
 * `--check` exits 1 when a committed file is stale instead of writing it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderApiEnvExample, renderEnvExample } from "../src/envExample";
import { renderManifest } from "../src/manifest";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const root = path.resolve(pkg, "../..");

export const OUTPUTS: Array<{ file: string; render: () => string }> = [
  { file: path.join(root, ".env.example"), render: renderEnvExample },
  { file: path.join(root, "apps/api/.env.example"), render: renderApiEnvExample },
  { file: path.join(pkg, "env-manifest.json"), render: renderManifest },
];

const check = process.argv.includes("--check");
let stale = 0;
for (const { file, render } of OUTPUTS) {
  const next = render();
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // missing counts as stale
  }
  if (current === next) continue;
  if (check) {
    stale++;
    console.error(`stale: ${path.relative(process.cwd(), file)} (run npm run env:example)`);
  } else {
    writeFileSync(file, next);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}
if (stale) process.exit(1);
