/**
 * Scheduled-task webhook tokens (GOAT G8). Each scheduled task can carry one
 * secret token. It is shown once when it is made, and only its SHA-256 is
 * stored, so a database read never yields a working token. A delivery proves
 * it knows the token with `Authorization: Bearer <token>` (or the
 * `x-fhara-token` header); `?token=` works for senders that cannot set
 * headers. Because only the hash is kept, an HMAC body signature (which needs
 * the plain secret on this side) is not offered.
 *
 * `constantTimeEquals` is adapted from GOAT
 * `apps/server/src/scheduledTasks/webhookVerification.ts`
 * (https://github.com/goat-si/goat, commit 718f5b11), MIT License,
 * Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 goat-si contributors.
 * Modified by Fhara, 2026-11: node:crypto became Web Crypto (Convex default
 * runtime), and the HMAC header check became a hashed bearer-token check.
 * See THIRD_PARTY_NOTICES.md (## GOAT).
 */
import { bytesToHex } from "./githubWebhook";

/** The prefix makes a leaked token easy to recognise and grep for. */
export const WEBHOOK_TOKEN_PREFIX = "fhk_";
const TOKEN_SHAPE = /^fhk_[0-9a-f]{64}$/;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Constant-time string comparison that does not leak length through timing. */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < digestA.length; i++) diff |= digestA[i]! ^ digestB[i]!;
  return diff === 0;
}

/** A fresh token: 32 random bytes as hex behind the prefix (call from an action). */
export function generateWebhookToken(): string {
  return `${WEBHOOK_TOKEN_PREFIX}${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The stored form of a token. */
export async function hashWebhookToken(token: string): Promise<string> {
  return bytesToHex(await sha256(token));
}

/** The token a delivery presents, from the bearer header, `x-fhara-token`, or `?token=`. */
export function presentedWebhookToken(headers: Headers, url: URL): string | null {
  const auth = headers.get("authorization")?.trim();
  const bearer = auth && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : null;
  const token = bearer || headers.get("x-fhara-token")?.trim() || url.searchParams.get("token")?.trim() || null;
  return token || null;
}

/** True when `token` matches the stored hash. Fails closed on any missing piece. */
export async function verifyWebhookToken(token: string | null, storedHash: string | null | undefined): Promise<boolean> {
  if (!token || !storedHash || !TOKEN_SHAPE.test(token)) return false;
  return await constantTimeEquals(await hashWebhookToken(token), storedHash);
}

/**
 * Headers a sender uses for its own delivery id, first match wins. A retry
 * of the same delivery carries the same id, so it dispatches once.
 */
export const DELIVERY_ID_HEADERS = ["x-fhara-delivery", "idempotency-key", "x-github-delivery", "x-delivery-id", "x-request-id"] as const;

export function deliveryIdFrom(headers: Headers): string | null {
  for (const name of DELIVERY_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}
