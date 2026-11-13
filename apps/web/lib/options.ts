/**
 * Machine-readable choice blocks a chat agent appends when presenting
 * options for the user to pick (see chat prompt guidance):
 *
 *   [options]
 *   A|Calm sheet|3 tiers, one line each|sheet
 *   B|Bold cards|Bigger middle tier|bold
 *   [/options]
 *
 * Fields are `id|title|summary|preview`. `preview` picks the wireframe:
 * sheet (three columns, middle tile outlined), bold (large centered
 * card), rows (stacked list), plain (no preview). Anything else (or
 * fewer than two options) is not a choice block — render as plain text.
 */
export type ChatOption = {
  id: string;
  title: string;
  summary: string;
  preview: "sheet" | "bold" | "rows" | "plain";
  /** Optional real wireframe: rows split by "/", regions by "+", a
   *  region may carry a width weight ("Editor*2"). Example:
   *  "Toolbar / Templates + Editor*2 + Preview A4". */
  layout?: LayoutRow[];
};

export type LayoutRow = { label: string; weight: number }[];

/** Parses the layout field; returns undefined when it is not one. */
function parseLayout(spec: string | undefined): LayoutRow[] | undefined {
  if (!spec || !/[+/]/.test(spec)) return undefined;
  const rows = spec
    .split("/")
    .map((row) =>
      row
        .split("+")
        .map((cell) => {
          const m = cell.trim().match(/^(.*?)(?:\*(\d(?:\.\d)?))?$/);
          const label = (m?.[1] ?? "").trim().slice(0, 28);
          const weight = Math.min(4, Math.max(1, Number(m?.[2] ?? 1) || 1));
          return { label, weight };
        })
        .filter((c) => c.label)
        .slice(0, 4),
    )
    .filter((r) => r.length)
    .slice(0, 4);
  return rows.length ? rows : undefined;
}

const PREVIEW_STYLES = new Set(["sheet", "bold", "rows", "plain"]);

export function parseOptions(content: string): { text: string; options: ChatOption[] } {
  const match = /\[options\]([\s\S]*?)\[\/options\]/.exec(content);
  if (!match) return { text: content, options: [] };
  const options: ChatOption[] = [];
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed) continue;
    const [id, title, summary, preview, layoutSpec] = trimmed.split("|").map((part) => (part ?? "").trim());
    const layout = parseLayout(layoutSpec);
    if (!id || !title) continue;
    options.push({
      id,
      title,
      summary: summary ?? "",
      preview: PREVIEW_STYLES.has((preview ?? "").toLowerCase())
        ? ((preview ?? "").toLowerCase() as ChatOption["preview"])
        : layout ? "sheet" : "plain",
      ...(layout ? { layout } : {}),
    });
  }
  if (options.length < 2) return { text: content, options: [] };
  const text = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`.trim();
  return { text, options };
}
