/**
 * `design_lookup`: the Designer's read-only search over the trimmed UI/UX
 * database (src/vendor/ui-ux-pro-max/data.json).
 *
 * Data and ranking: github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT,
 * Copyright (c) 2024 Next Level Builder). The BM25 class of
 * src/ui-ux-pro-max/scripts/core.py is ported to TypeScript here; modified
 * by Fhara: one index per table, plain-text results capped for a prompt,
 * no domain auto-detection. See THIRD_PARTY_NOTICES.md.
 */
import { readFileSync } from "node:fs";

export const DESIGN_LOOKUP_TOOL_NAME = "design_lookup";
export const DESIGN_LOOKUP_TABLES = ["style", "color", "typography", "ux", "product"] as const;
export type DesignLookupTable = (typeof DESIGN_LOOKUP_TABLES)[number];

const MAX_RESULTS = 8;
const DEFAULT_RESULTS = 4;
const RESULT_MAX_CHARS = 4_000;

type Row = Record<string, string>;
let tables: Record<DesignLookupTable, Row[]> | null = null;
/** Read lazily (256 KB): only a Designer run that calls the tool pays for it. */
function loadTables(): Record<DesignLookupTable, Row[]> {
  if (!tables) {
    const file = new URL("../vendor/ui-ux-pro-max/data.json", import.meta.url);
    tables = (JSON.parse(readFileSync(file, "utf8")) as { tables: Record<DesignLookupTable, Row[]> }).tables;
  }
  return tables;
}

export const DESIGN_LOOKUP_TOOL = {
  name: DESIGN_LOOKUP_TOOL_NAME,
  description:
    'Read-only search of the UI/UX database (styles, colour palettes by product type, font pairings, UX guidelines, product patterns). Arguments: {"table":"style"|"color"|"typography"|"ux"|"product","query":"2-5 words","limit":4}.',
  inputSchema: {
    type: "object",
    properties: {
      table: { type: "string", enum: [...DESIGN_LOOKUP_TABLES] },
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["table", "query"],
  },
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** BM25 (k1 = 1.5, b = 0.75), as in ui-ux-pro-max core.py. */
export class Bm25 {
  private readonly docs: string[][] = [];
  private readonly idf = new Map<string, number>();
  private avgdl = 0;

  constructor(documents: readonly string[], private readonly k1 = 1.5, private readonly b = 0.75) {
    this.docs = documents.map(tokenize);
    const n = this.docs.length;
    this.avgdl = n ? this.docs.reduce((sum, d) => sum + d.length, 0) / n : 0;
    const df = new Map<string, number>();
    for (const doc of this.docs) for (const word of new Set(doc)) df.set(word, (df.get(word) ?? 0) + 1);
    for (const [word, freq] of df) this.idf.set(word, Math.log((n - freq + 0.5) / (freq + 0.5) + 1));
  }

  /** [index, score] pairs, best first, score > 0 only. */
  score(query: string): Array<[number, number]> {
    const terms = tokenize(query);
    const out: Array<[number, number]> = [];
    this.docs.forEach((doc, index) => {
      const tf = new Map<string, number>();
      for (const w of doc) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const term of terms) {
        const idf = this.idf.get(term);
        const f = tf.get(term);
        if (!idf || !f) continue;
        score += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgdl || 1)));
      }
      if (score > 0) out.push([index, score]);
    });
    return out.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  }
}

const indexes = new Map<DesignLookupTable, Bm25>();
function indexFor(table: DesignLookupTable): Bm25 {
  let index = indexes.get(table);
  if (!index) {
    index = new Bm25(loadTables()[table].map((row) => Object.values(row).join(" ")));
    indexes.set(table, index);
  }
  return index;
}

function formatRow(row: Row): string {
  const { name, ...rest } = row;
  return [`- ${name ?? "(unnamed)"}`, ...Object.entries(rest).map(([k, v]) => `  ${k}: ${v}`)].join("\n");
}

export function designLookup(args: Record<string, unknown>): { ok: boolean; text: string; isError: boolean } {
  const table = String(args.table ?? "").trim().toLowerCase() as DesignLookupTable;
  if (!DESIGN_LOOKUP_TABLES.includes(table)) {
    return { ok: false, isError: true, text: `table must be one of ${DESIGN_LOOKUP_TABLES.join(", ")}` };
  }
  const query = String(args.query ?? "").trim().slice(0, 200);
  if (!query) return { ok: false, isError: true, text: "query is required (2-5 words)" };
  const limitRaw = Number(args.limit ?? DEFAULT_RESULTS);
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_RESULTS));
  const hits = indexFor(table).score(query).slice(0, limit);
  if (hits.length === 0) {
    return { ok: true, isError: false, text: `No ${table} match for "${query}". Retry once with narrower words, or say no verified match was found.` };
  }
  let text = `${hits.length} ${table} result${hits.length === 1 ? "" : "s"} for "${query}" (ui-ux-pro-max data, MIT):\n`;
  for (const [index] of hits) {
    const block = formatRow(loadTables()[table][index]);
    if (text.length + block.length + 1 > RESULT_MAX_CHARS) break;
    text += `${block}\n`;
  }
  return { ok: true, isError: false, text: text.trimEnd() };
}
