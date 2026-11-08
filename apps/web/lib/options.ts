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
};

const PREVIEW_STYLES = new Set(["sheet", "bold", "rows", "plain"]);

export function parseOptions(content: string): { text: string; options: ChatOption[] } {
  const match = /\[options\]([\s\S]*?)\[\/options\]/.exec(content);
  if (!match) return { text: content, options: [] };
  const options: ChatOption[] = [];
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed) continue;
    const [id, title, summary, preview] = trimmed.split("|").map((part) => (part ?? "").trim());
    if (!id || !title) continue;
    options.push({
      id,
      title,
      summary: summary ?? "",
      preview: PREVIEW_STYLES.has((preview ?? "").toLowerCase())
        ? ((preview ?? "").toLowerCase() as ChatOption["preview"])
        : "plain",
    });
  }
  if (options.length < 2) return { text: content, options: [] };
  const text = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`.trim();
  return { text, options };
}
