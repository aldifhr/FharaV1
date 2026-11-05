import { ConvexHttpClient } from "convex/browser";

export function createConvexClient(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");
  const token = process.env.CONVEX_SERVICE_TOKEN;
  if (!token) throw new Error("CONVEX_SERVICE_TOKEN missing");
  return new ConvexHttpClient(url);
}

// Thin wrapper so worker bisa tanpa framework tiruan.
// ponytail: satu file cukup; kalau nambah provider LLM lain baru buat abstraction lebih.
export async function callMutation(
  client: ConvexHttpClient,
  fn: any,
  args: Record<string, unknown>
): Promise<any> {
  return await client.mutation(fn, args);
}

export async function callQuery(
  client: ConvexHttpClient,
  fn: any,
  args: Record<string, unknown>
): Promise<any> {
  return await client.query(fn, args);
}
