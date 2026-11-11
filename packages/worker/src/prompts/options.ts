/**
 * Prompt text for the options review (show_options) tool loop.
 */
export function optionsInstruction(opts: { required: boolean; designLookup: boolean }): string {
  return [
    "## Asking the user to choose (show_options)",
    opts.required
      ? "This subtask asks for an options review: call show_options exactly once before you answer."
      : "When the work has more than one reasonable direction, call show_options once to let the user pick before you answer. When one answer is obvious, skip it and answer directly.",
    "- Give 2-4 options with ids A, B, C…, each with a one- or two-sentence trade-off note, and set `recommended` to the id you would pick.",
    '- Design work: each option is {"kind":"html","html":"<!doctype html>…"}: ONE static page, HTML + inline <style> only. No <script>, no on* attributes, no forms, iframes, embeds or <base>, no external URLs (fonts, images, CDNs, @import). Images only as data:image URIs. Use the app\'s existing design tokens. Set `route` to the app path the design is for.',
    '- Trade-offs that are text (architecture, schema, research, deploy): use {"kind":"markdown","markdown":"…"} with a short table or bullets.',
    "- If the tool returns findings, fix every one and call show_options again.",
    "- The tool waits for the user and returns their picks, notes and reply. Then write your final result for the picked option(s), folding in the notes. If they picked none, propose a revised direction from their reply; do not build anything.",
    ...(opts.designLookup
      ? ['- design_lookup {"table":"style"|"color"|"typography"|"ux"|"product","query":"2-5 words"} searches the UI/UX database; in an existing app its tokens win over any palette from it.']
      : []),
  ].join("\n");
}
