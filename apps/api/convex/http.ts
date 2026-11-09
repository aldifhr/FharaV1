import { httpRouter } from "convex/server";
import { handleOAuthCallback, handleWebhook } from "./integrations";

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

// GitHub webhooks. Every delivery is HMAC-verified (x-hub-signature-256)
// before it is parsed; with no secret configured the handler answers 401.
// `/integrations/github/webhook/<integrationId>` uses that integration's
// secret (then GITHUB_WEBHOOK_SECRET); the bare path uses the env secret.
http.route({
  path: "/integrations/github/webhook",
  method: "POST",
  handler: handleWebhook,
});
http.route({
  pathPrefix: "/integrations/github/webhook/",
  method: "POST",
  handler: handleWebhook,
});

export default http;
