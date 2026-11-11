/**
 * Typed LLM wire failures for the worker. The classes and guards live in
 * the shared pure module (apps/api/convex/lib/llmWireErrors.ts) so the
 * backend's chat client raises the same ones; this file re-exports them.
 */
export {
  asDroppedConnection,
  contextLimitOf,
  isContextOverflowError,
  isIncompleteResponseError,
  LlmConnectionError,
  LlmContextOverflowError,
  LlmIncompleteResponseError,
  LlmMalformedResponseError,
  LlmWireError,
  partialTextOf,
  type LlmWireErrorKind,
} from "@/api/convex/lib/llmWireErrors";
