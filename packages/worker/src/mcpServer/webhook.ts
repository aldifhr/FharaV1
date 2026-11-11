/**
 * GOAT G12b: the optional signed completion webhook of the Fhara MCP server.
 *
 * When FHARA_MCP_WEBHOOK_URL and FHARA_MCP_WEBHOOK_SECRET are set, every
 * newly recorded `run.report_result` (not a deduped repeat, not a refusal)
 * is POSTed there as JSON. The receiver checks
 *
 *   X-Fhara-Timestamp: <unix ms>
 *   X-Fhara-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *
 * with `verifyWebhookSignature` (constant-time, rejects stale timestamps).
 * Delivery is best effort: one attempt with a timeout, never awaited by the
 * tool call, a failure logs one line without the URL's query or the secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { McpRunReportResult, McpSource } from "./types";

export const WEBHOOK_SIGNATURE_HEADER = "x-fhara-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-fhara-timestamp";
export const WEBHOOK_MIN_SECRET_LENGTH = 16;
/** A signature older (or further in the future) than this is refused. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
const DELIVERY_TIMEOUT_MS = 5_000;

export interface McpWebhookConfig {
  url: string;
  secret: string;
}

export interface McpCompletionEvent {
  event: "run.completed";
  taskId: string;
  projectId: string;
  status: "succeeded" | "failed";
  summary: string;
  reportedAt: number;
  clientRequestId: string;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** True when `signature` is the HMAC of this exact body and timestamp, and the timestamp is fresh. */
export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  now?: number;
  toleranceMs?: number;
}): boolean {
  const { secret, body, timestamp, signature } = input;
  if (!secret || !timestamp || !signature || !/^\d{1,16}$/.test(timestamp)) return false;
  const skew = Math.abs((input.now ?? Date.now()) - Number(timestamp));
  if (skew > (input.toleranceMs ?? WEBHOOK_TOLERANCE_MS)) return false;
  const expected = Buffer.from(signWebhookBody(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The config when both env values are usable, else null with the reason (for one startup log line). */
export function webhookConfigFrom(url: string, secret: string): { config: McpWebhookConfig | null; problem?: string } {
  if (!url && !secret) return { config: null };
  if (!url) return { config: null, problem: "FHARA_MCP_WEBHOOK_SECRET is set but FHARA_MCP_WEBHOOK_URL is blank" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { config: null, problem: "FHARA_MCP_WEBHOOK_URL is not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { config: null, problem: "FHARA_MCP_WEBHOOK_URL must be http(s)" };
  }
  if (secret.length < WEBHOOK_MIN_SECRET_LENGTH) {
    return { config: null, problem: `FHARA_MCP_WEBHOOK_SECRET is missing or under ${WEBHOOK_MIN_SECRET_LENGTH} characters` };
  }
  return { config: { url: parsed.toString(), secret } };
}

/** POST one signed event. Resolves to whether the receiver answered 2xx; never throws. */
export async function deliverWebhook(
  config: McpWebhookConfig,
  event: McpCompletionEvent,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<boolean> {
  const body = JSON.stringify(event);
  const timestamp = String(now());
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(config.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`[mcp-server] completion webhook answered ${res.status} (${new URL(config.url).origin})`);
    return res.ok;
  } catch (error) {
    const name = error instanceof Error ? error.name : "error";
    console.warn(`[mcp-server] completion webhook failed: ${name} (${new URL(config.url).origin})`);
    return false;
  }
}

/** The source with `runReportResult` also firing the webhook for each newly recorded result. */
export function withCompletionWebhook(
  source: McpSource,
  config: McpWebhookConfig,
  deliver: (event: McpCompletionEvent) => Promise<unknown> = (event) => deliverWebhook(config, event)
): McpSource {
  return {
    ...source,
    runReportResult: async (input) => {
      const result: McpRunReportResult = await source.runReportResult(input);
      if (result.kind === "recorded" && !result.deduped) {
        void deliver({
          event: "run.completed",
          taskId: result.taskId,
          projectId: result.projectId,
          status: result.status,
          summary: result.summary,
          reportedAt: result.reportedAt,
          clientRequestId: input.clientRequestId,
        }).catch(() => undefined);
      }
      return result;
    },
  };
}
