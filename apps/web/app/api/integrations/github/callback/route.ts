import { NextRequest, NextResponse } from "next/server";
import { publicConvexUrl } from "@/lib/env.client";
import { serverEnv } from "@/lib/env.server";

/**
 * Plan 019: GitHub OAuth callback. The OAuth app points at the web origin
 * (GITHUB_OAUTH_CALLBACK_URL defaults to this route); the code exchange
 * happens in the Convex http action, so this route only forwards the query
 * string there. No token passes through the web server.
 */
function convexSiteUrl(): string | null {
  const site = serverEnv("CONVEX_SITE_URL");
  if (site) return site.replace(/\/$/, "");
  const cloud = publicConvexUrl();
  if (!cloud) return null;
  // Hosted: https://<name>.convex.cloud → https://<name>.convex.site.
  if (/\.convex\.cloud\/?$/.test(cloud)) return cloud.replace(/\.convex\.cloud\/?$/, ".convex.site");
  // Local backend: HTTP actions are served one port above the API port.
  try {
    const url = new URL(cloud);
    if (url.port) {
      url.port = String(Number(url.port) + 1);
      return url.origin;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function GET(request: NextRequest) {
  const site = convexSiteUrl();
  if (!site) {
    return NextResponse.json(
      { error: "Set CONVEX_SITE_URL (or NEXT_PUBLIC_CONVEX_URL) so the GitHub callback can reach the backend." },
      { status: 500 }
    );
  }
  return NextResponse.redirect(`${site}/integrations/github/callback${request.nextUrl.search}`);
}
