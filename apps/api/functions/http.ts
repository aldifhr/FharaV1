import { httpRouter } from "@fhara/runtime/server";
import { handleWebhook } from "./integrations";
import { handleScheduledHook } from "./scheduledTaskHooks";

/**
 * Plan 079: GitHub uses the operator's local `gh` login, so no OAuth
 * callback route exists. Webhooks and scheduled hooks are unchanged.
 */
const http = httpRouter();

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

// GOAT G8: fire one scheduled task by id. Authenticated with the task's own
// token (hashed at rest); idempotent per delivery id; waits while automation
// is held. See scheduledTaskHooks.ts.
http.route({
  pathPrefix: "/hooks/scheduled/",
  method: "POST",
  handler: handleScheduledHook,
});

export default http;
