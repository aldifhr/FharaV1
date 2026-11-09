import { NextResponse } from "next/server";
import { checkApiRequest, isSameOrigin, type GuardInput } from "./requestGuard";

/**
 * Route-level copy of the `proxy.ts` check, so each sensitive handler stays
 * guarded even if the proxy matcher changes. Returns a 403 response to
 * send, or null when the request may proceed.
 */
export function rejectUnsafeRequest(request: GuardInput): NextResponse | null {
  const verdict = checkApiRequest(request);
  if (verdict.ok) return null;
  return NextResponse.json({ error: verdict.reason }, { status: verdict.status });
}

/** Origin header present and naming this server (no "missing Origin" pass). */
export function isStrictSameOrigin(request: GuardInput): boolean {
  return isSameOrigin(request, true);
}
