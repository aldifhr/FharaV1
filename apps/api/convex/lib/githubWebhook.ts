/**
 * GitHub webhook signature verification (security fix, plan: webhook guard).
 *
 * GitHub signs every delivery with `X-Hub-Signature-256: sha256=<hex>`, the
 * HMAC-SHA256 of the RAW request body under the webhook secret. We verify it
 * with Web Crypto's `crypto.subtle.verify("HMAC", …)`, which compares the MAC
 * in constant time, so no hand-rolled string compare can leak timing.
 *
 * Fail closed: a missing header, a malformed header, or no configured secret
 * all reject. Pure and runtime-agnostic (Convex default runtime and the
 * edge-runtime test VM both expose `crypto.subtle`).
 */

const SIGNATURE_PREFIX = "sha256=";
/** SHA-256 output is 32 bytes = 64 hex chars. */
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing_signature" | "malformed_signature" | "no_secret" | "bad_signature" };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function hmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

/** `sha256=<hex>` for a body, exactly as GitHub sends it (tests + docs). */
export async function signGithubPayload(secret: string, rawBody: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  return `${SIGNATURE_PREFIX}${bytesToHex(mac)}`;
}

/**
 * Verify `X-Hub-Signature-256` against the raw body. Never throws: every
 * failure is a typed `ok: false`, so the caller can only fail closed.
 */
export async function verifyGithubSignature(
  secret: string | null | undefined,
  rawBody: string,
  signatureHeader: string | null | undefined
): Promise<SignatureCheck> {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const header = signatureHeader.trim();
  if (!header.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "malformed_signature" };
  const hex = header.slice(SIGNATURE_PREFIX.length);
  if (!HEX_SHA256.test(hex)) return { ok: false, reason: "malformed_signature" };
  try {
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBytes(hex) as unknown as ArrayBuffer,
      new TextEncoder().encode(rawBody) as unknown as ArrayBuffer
    );
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/** A fresh webhook secret: 32 random bytes as hex (call from an action). */
export function generateWebhookSecretValue(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Events we accept. Anything else is acknowledged and ignored. */
export const HANDLED_GITHUB_EVENTS = new Set(["ping", "push", "pull_request", "issues", "issue_comment", "check_run", "check_suite", "pull_request_review"]);

/** How long delivery ids are kept for replay dedupe. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
