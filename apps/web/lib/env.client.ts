/**
 * NEXT_PUBLIC_* reads for client and server code. They must stay literal
 * `process.env.NEXT_PUBLIC_X` expressions: Next inlines only that exact
 * form into the bundles. No alias fallback (CONVEX_URL is never inlined).
 * The web env guard checks that every webClient var in @fhara/config is
 * read here and nowhere else.
 */

/** The Convex deployment URL the browser and the API routes talk to. */
export function publicConvexUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_CONVEX_URL;
}
