import { NextResponse, type NextRequest } from "next/server";
import { checkApiRequest } from "./lib/requestGuard";

/**
 * Next 16 proxy (formerly middleware): Host + same-origin gate for every
 * `/api/*` route. See lib/requestGuard.ts for the rules.
 */
export function proxy(request: NextRequest) {
  const verdict = checkApiRequest(request);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: verdict.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
