/**
 * Which environment variable a provider connection may name as `apiKeyEnv`
 * (release audit P0-3). The backend reads `process.env[apiKeyEnv]` and
 * sends it as a Bearer key to the provider's baseUrl, so an unchecked name
 * would let a provider row ship CONVEX_SERVICE_TOKEN,
 * PROVIDER_ENCRYPTION_KEY or a GitHub secret to any URL.
 *
 * Rule: an upper-case env-var name that is not a platform secret. Provider
 * keys (LLM_API_KEY, OPENAI_API_KEY, OPENROUTER_KEY, HF_TOKEN, …) pass.
 */
const DENIED_EXACT = new Set([
  "CONVEX_SERVICE_TOKEN",
  "PROVIDER_ENCRYPTION_KEY",
  "NEXT_PUBLIC_CONVEX_URL",
  "PATH",
  "HOME",
]);

const DENIED_PREFIXES = [
  "CONVEX_",
  "GITHUB_",
  "FHARA_",
  "MOAGENT_",
  "WORKER_",
  "ORCHESTRATOR_",
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_APPLICATION_",
  "NPM_",
  "SSH_",
  "VERCEL_",
];

const DENIED_WORDS = ["SECRET", "PASSWORD", "PASSWD", "PRIVATE", "SESSION", "COOKIE", "ENCRYPTION", "JWT", "JWKS", "DATABASE", "OAUTH", "SIGNING"];

export function isSafeApiKeyEnv(name: string | undefined | null): boolean {
  if (!name) return false;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return false;
  if (DENIED_EXACT.has(name)) return false;
  if (DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return !DENIED_WORDS.some((word) => name.includes(word));
}

export function assertSafeApiKeyEnv(name: string): void {
  if (!isSafeApiKeyEnv(name)) {
    throw new Error(
      `apiKeyEnv "${name.slice(0, 64)}" is not allowed: use an upper-case provider key variable such as LLM_API_KEY or OPENAI_API_KEY (platform secrets are refused).`,
    );
  }
}
