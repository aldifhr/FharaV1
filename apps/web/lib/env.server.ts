/**
 * Server-side env for route handlers and server code: Fhara vars through
 * @fhara/config's web-server reader (schema dialect, default and aliases).
 * Never import this from a "use client" module. NEXT_PUBLIC_* vars come
 * from ./env.client instead.
 */
export { serverEnv, serverEnvRaw } from "@fhara/config/web-server";
export type { WebServerVarName } from "@fhara/config/web-server";
