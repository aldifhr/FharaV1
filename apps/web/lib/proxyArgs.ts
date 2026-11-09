/**
 * Helpers for the service-token proxy routes (llm-providers, mcp-servers,
 * magic-prompt). Release audit P0-3: those routes used to spread the whole
 * request body into the Convex call next to CONVEX_SERVICE_TOKEN, so the
 * caller decided every argument of an admin call. Now each operation names
 * the exact fields it forwards; anything else (including a caller-supplied
 * `token`/`workerToken`) is dropped before the token is attached.
 */
export function pickFields(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) {
      picked[field] = body[field];
    }
  }
  return picked;
}

/** Reject request bodies that are not plain JSON objects or are oversized. */
export async function readJsonObject(
  request: { headers: { get(name: string): string | null }; text(): Promise<string> },
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** http(s) URL check for caller-supplied base URLs. */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
