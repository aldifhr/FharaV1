/**
 * Local-MCP policy for /api/mcp-servers (release audit P0-3). Pure, so it
 * is unit-tested directly.
 */
/** True when this write would store a caller-chosen local command. */
export function setsLocalCommand(action: string, payload: Record<string, unknown>): boolean {
  switch (action) {
    case "add":
      return payload.type !== "remote" || payload.command !== undefined || payload.args !== undefined;
    case "create":
      return payload.presetId === "custom" && payload.type !== "remote";
    case "update":
      return payload.type === "local" || payload.command !== undefined || payload.commandArgs !== undefined;
    default:
      return false;
  }
}
