import { NextRequest, NextResponse } from "@/lib/serverCompat";
import { publicFharaRuntimeUrl } from "@/lib/env.client";
import { serverEnv } from "@/lib/env.server";

/**
 * Plan 019: GitHub OAuth callback. The OAuth app points at the web origin
 * (GITHUB_OAUTH_CALLBACK_URL defaults to this route); the code exchange
 * happens in the FharaRuntime http action, so this route only forwards the query
 * string there. No token passes through the web server.
 */
function runtimeSiteUrl(): string | null {
  const site = serverEnv("FHARA_SITE_URL");
  if (site) return site.replace(/\/$/, "");
  const cloud = publicFharaRuntimeUrl();
  if (!cloud) return null;
  // Hosted: https://<name>.runtime.cloud → https://<name>.runtime.site.
  if (/\.runtime\.cloud\/?$/.test(cloud)) return cloud.replace(/\.runtime\.cloud\/?$/, ".runtime.site");
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
  const site = runtimeSiteUrl();
  if (!site) {
    return NextResponse.json(
      { error: "Set FHARA_SITE_URL (or FHARA_BACKEND_URL) so the GitHub callback can reach the backend." },
      { status: 500 }
    );
  }
  return NextResponse.redirect(`${site}/integrations/github/callback${request.nextUrl.search}`);
}
