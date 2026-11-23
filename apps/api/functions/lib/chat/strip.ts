import { stripToolCallText } from "./toolCallText";

/**
 * Remove tool-call text some models emit in a chat reply: tagged blocks
 * (`<tool_call>`, `<longcat_tool_call>`, an unterminated one with everything
 * after it), fenced or bare JSON calls on their own lines, and stray tags.
 * See toolCallText.ts.
 */
export function stripToolCallMarkup(text: string): string {
  return stripToolCallText(text);
}

/** Tag markup a model emits for a tool call (`<longcat_tool_call>`, `<tool_call>`, arg tags). */
const TOOL_CALL_TAG = /<\/?\s*(?:longcat_)?(?:tool_call|arg_key|arg_value)\b/i;

/**
 * Last guard before an agent chat reply is stored: tagged tool-call markup
 * never reaches the database (night e2e R-b: 2 of 159 CTO replies kept a
 * `<longcat_tool_call>`). Only tagged markup triggers it, so a reply that
 * shows JSON on purpose is stored as written.
 */
export function stripLeakedToolCallTags(text: string): string {
  return TOOL_CALL_TAG.test(text) ? stripToolCallText(text).trim() : text;
}
