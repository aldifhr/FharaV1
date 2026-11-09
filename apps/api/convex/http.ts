import { httpRouter } from "convex/server";
import { handleOAuthCallback } from "./integrations";

/**
 * Plan 019: HTTP routes for the GitHub integration. The Next app forwards
 * its OAuth callback URL (`/api/integrations/github/callback`) here, so the
 * GitHub OAuth app can keep pointing at the web origin.
 */
const http = httpRouter();

http.route({
  path: "/integrations/github/callback",
  method: "GET",
  handler: handleOAuthCallback,
});

// The webhook handler is not routed yet: it does not verify the
// `x-hub-signature-256` signature, so it must not be reachable publicly.

export default http;
