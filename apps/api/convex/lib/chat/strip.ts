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
