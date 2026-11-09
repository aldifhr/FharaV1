/**
 * Remove tool-call markup some models emit as plain text (chat agents have
 * no tools): complete blocks, and an unterminated one with everything after it.
 */
export function stripToolCallMarkup(text: string): string {
  const open = /<(?:[a-z_]+_)?tool_call\b[^>]*>/i;
  let out = text.replace(/<((?:[a-z_]+_)?tool_call)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const dangling = out.search(open);
  if (dangling >= 0) out = out.slice(0, dangling);
  return out.replace(/[ \t]{2,}/g, " ").trim();
}
