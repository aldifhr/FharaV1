#!/usr/bin/env node
/**
 * Builds packages/worker/src/vendor/ui-ux-pro-max/data.json, the trimmed
 * UI/UX database the Designer's read-only `design_lookup` tool searches.
 *
 *   node scripts/build-uiux-data.mjs ../ref/ui-ux-pro-max-skill
 *
 * Source: github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT,
 * Copyright (c) 2024 Next Level Builder), src/ui-ux-pro-max/data/*.csv.
 * Modified by Fhara: only five tables are kept (styles, color palettes,
 * font pairings, UX guidelines, product types), each cut to the columns a
 * design decision needs. Attribution: THIRD_PARTY_NOTICES.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/worker/src/vendor/ui-ux-pro-max/data.json");

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((c) => c.trim())) rows.push(row);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^\uFEFF/, "").trim(), (r[i] ?? "").trim()])));
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function pick(rows, map, max = 220) {
  return rows.map((row) => {
    const out = {};
    for (const [to, from] of Object.entries(map)) {
      const value = cut(String(row[from] ?? "").replace(/\s+/g, " ").trim(), max);
      if (value) out[to] = value;
    }
    return out;
  });
}

function main() {
  const src = resolve(process.argv[2] ?? "../ref/ui-ux-pro-max-skill");
  const data = join(src, "src/ui-ux-pro-max/data");
  const read = (f) => parseCsv(readFileSync(join(data, f), "utf8"));
  let sha = null;
  try {
    sha = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // Not a clone: the sha stays unknown.
  }
  const styles = read("styles.csv").filter((r) => !/deprecated|retired/i.test(r.Status ?? ""));
  const out = {
    source: "nextlevelbuilder/ui-ux-pro-max-skill",
    license: "MIT",
    copyright: "Copyright (c) 2024 Next Level Builder",
    sha,
    tables: {
      style: pick(styles, {
        name: "Style Category",
        keywords: "Keywords",
        colors: "Primary Colors",
        effects: "Effects & Animation",
        bestFor: "Best For",
        avoidFor: "Do Not Use For",
        accessibility: "Accessibility",
      }),
      color: pick(read("colors.csv"), {
        name: "Product Type",
        primary: "Primary",
        secondary: "Secondary",
        accent: "Accent",
        background: "Background",
        foreground: "Foreground",
        muted: "Muted",
        border: "Border",
        destructive: "Destructive",
        notes: "Notes",
      }),
      typography: pick(read("typography.csv"), {
        name: "Font Pairing Name",
        category: "Category",
        heading: "Heading Font",
        body: "Body Font",
        mood: "Mood/Style Keywords",
        bestFor: "Best For",
        notes: "Notes",
      }),
      ux: pick(read("ux-guidelines.csv"), {
        name: "Issue",
        category: "Category",
        platform: "Platform",
        description: "Description",
        do: "Do",
        dont: "Don't",
        severity: "Severity",
      }),
      product: pick(read("products.csv"), {
        name: "Product Type",
        keywords: "Keywords",
        style: "Primary Style Recommendation",
        secondary: "Secondary Styles",
        landing: "Landing Page Pattern",
        dashboard: "Dashboard Style (if applicable)",
        palette: "Color Palette Focus",
        considerations: "Key Considerations",
      }),
    },
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out)}\n`);
  const counts = Object.fromEntries(Object.entries(out.tables).map(([k, v]) => [k, v.length]));
  console.log(`wrote ${OUT}`, counts);
}

main();
