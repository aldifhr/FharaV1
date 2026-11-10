/**
 * Signed, single-use OAuth `state` (GitHub connect).
 *
 * state = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload part))
 *
 * The payload carries a random nonce; the nonce row (`oauthStates`) is
 * consumed exactly once by the callback, so a state can be neither forged
 * (signature), replayed (nonce), nor kept around (max age).
 *
 * Web Crypto only (`crypto.subtle`, btoa/atob, TextEncoder): Convex runs
 * functions in a V8 isolate without Node's `Buffer`.
 */
import { cenv, cenvRaw } from "@fhara/config/convex";

export const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
/** Nonce rows older than this are pruned. */
export const OAUTH_STATE_RETENTION_MS = 60 * 60_000;
/** Tolerated clock skew for an `iat` slightly in the future. */
const FUTURE_SKEW_MS = 60_000;

export type OAuthStatePayload = { v: 1; p: "github"; n: string; iat: number };

export type VerifyResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** OAUTH_STATE_SECRET, falling back to PROVIDER_ENCRYPTION_KEY. */
export function oauthStateSecret(): string | null {
  return cenv("OAUTH_STATE_SECRET") || cenvRaw("PROVIDER_ENCRYPTION_KEY")?.trim() || null;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

/**
 * Constant-time compare of `presented` against `expected`: the loop always
 * runs over every byte of `expected` (a fixed 32-byte HMAC), with no early
 * exit on the first differing byte or on a length mismatch.
 */
export function timingSafeEqualBytes(expected: Uint8Array, presented: Uint8Array): boolean {
  let diff = expected.length ^ presented.length;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ (presented[i] ?? 0);
  return diff === 0;
}

/** 32 random bytes, base64url. */
export function newOAuthNonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signOAuthState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${bytesToBase64Url(await hmac(secret, body))}`;
}

export async function verifyOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
  maxAgeMs = OAUTH_STATE_MAX_AGE_MS
): Promise<VerifyResult> {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || state.length > 2048) return { ok: false, reason: "malformed" };
  let presented: Uint8Array;
  try {
    presented = base64UrlToBytes(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = await hmac(secret, parts[0]);
  if (!timingSafeEqualBytes(expected, presented)) return { ok: false, reason: "bad_signature" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !payload ||
    payload.v !== 1 ||
    payload.p !== "github" ||
    typeof payload.n !== "string" ||
    payload.n.length < 16 ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.iat > now + FUTURE_SKEW_MS || now - payload.iat > maxAgeMs) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** A same-app relative path to return to after connecting, or undefined. */
export function safeReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  return value;
}

/**
 * The web app origin the OAuth popup posts back to: APP_ORIGIN, else the
 * origin of GITHUB_OAUTH_CALLBACK_URL (the callback is served by the web
 * app and forwarded to Convex), else the local dev default.
 */
export function appOrigin(): string {
  for (const raw of [cenvRaw("APP_ORIGIN"), cenvRaw("GITHUB_OAUTH_CALLBACK_URL")]) {
    if (!raw?.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // try the next source
    }
  }
  return "http://localhost:3000";
}
