/**
 * Provider model discovery (Settings: validate a key on save, "Add model"
 * picker, Test on a connection without models). Pure apart from fetch.
 */
import { modelListHeaders, parseModelList } from "./llmPresets";
import { endpointCandidates, errorBodyExcerpt } from "./chat/llmEndpoint";

/**
 * GET the provider's model list with the auth its wire format expects
 * (Anthropic: x-api-key + anthropic-version; others: Bearer; a keyless
 * local server: none). Tries the base URL with and without /v1. A non-2xx
 * answer throws naming the status and a masked body excerpt, never the key.
 */
export async function listProviderModels(
  base: string,
  wire: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  const headers = modelListHeaders(wire, apiKey);
  const candidates = endpointCandidates(base, "/models");
  let lastStatus = 0;
  let lastBody = "";
  for (const [index, url] of candidates.entries()) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return parseModelList(await res.json());
    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");
    if (res.status === 404 && index < candidates.length - 1) continue;
    break;
  }
  const excerpt = errorBodyExcerpt(lastBody);
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(
      `The provider rejected the key (HTTP ${lastStatus})${apiKey ? "" : ": no key was sent"}${excerpt ? `: ${excerpt}` : ""}`
    );
  }
  throw new Error(`Provider returned HTTP ${lastStatus}${excerpt ? `: ${excerpt}` : ""}`);
}

