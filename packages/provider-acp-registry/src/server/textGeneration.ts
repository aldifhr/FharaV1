import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError, type ModelSelection } from "@fhara/contracts";
import * as AcpSessionRuntime from "@fhara/provider-acp/server/AcpSessionRuntime";
import type { ProviderTextGeneration } from "@fhara/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@fhara/provider-core/server/textGenerationOperations";

import type { AcpRegistrySettings } from "../settings.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const PLAN_TIMEOUT = Duration.minutes(10);

export interface AcpRegistryTextGenerationOptions {
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly provide: <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | AcpRegistrySupport.AcpRegistryCatalog
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
    >,
  ) => Effect.Effect<A, E>;
}

interface AcpPromptInput {
  readonly operation: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}

const generateAcpText = Effect.fn("AcpRegistryTextGeneration.generateText")(
  function* (options: AcpRegistryTextGenerationOptions, input: AcpPromptInput) {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const random = yield* SecureRandom.SecureRandom;
    const resolved = yield* catalog
      .resolve(options.settings, input.cwd, options.environment)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Could not resolve the ACP agent for text generation.",
              cause,
            }),
        ),
      );
    const runtimeContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: resolved.spawn,
        cwd: input.cwd,
        clientCapabilities: {
          auth: { terminal: false },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "fhara-text-generation", version: "0.0.0" },
        authenticateOnAuthRequired: false,
        ...(options.settings.authMethodId
          ? { authMethodId: options.settings.authMethodId }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(SecureRandom.SecureRandom, random),
          ),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(runtimeContext),
    );
    yield* runtime.handleRequestPermission(() =>
      Effect.succeed({ outcome: { outcome: "cancelled" } } as const),
    );
    const started = yield* runtime.start();
    if (started.sessionId.length === 0) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "The ACP agent did not create a session.",
      });
    }
    yield* runtime
      .setModel(input.modelSelection.model)
      .pipe(Effect.catch(() => Effect.logDebug("ACP text generation kept the session model.")));
    const chunks = yield* Ref.make<ReadonlyArray<string>>([]);
    const collector = yield* runtime.getEvents().pipe(
      Stream.runForEach((event) =>
        event._tag === "ContentDelta"
          ? Ref.update(chunks, (current) => [...current, event.text])
          : Effect.void,
      ),
      Effect.forkDetach,
    );
    yield* runtime.prompt({
      prompt: [{ type: "text", text: input.prompt }],
    });
    yield* Fiber.interrupt(collector);
    const text = (yield* Ref.get(chunks)).join("").trim();
    if (text.length === 0) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "The ACP agent returned empty output.",
      });
    }
    return text;
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: PLAN_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateOrchestrationPlan",
              detail: "The ACP agent did not finish generating the plan in time.",
            }),
          ),
      }),
      Effect.mapError((error) =>
        error._tag === "TextGenerationError"
          ? error
          : new TextGenerationError({
              operation: "generateOrchestrationPlan",
              detail: `The ACP agent failed to generate text (${(error as { _tag?: string })._tag ?? "unknown"}).`,
              cause: error,
            }),
      ),
    ),
);

export const makeAcpRegistryTextGeneration = (
  options: AcpRegistryTextGenerationOptions,
): ProviderTextGeneration => {
  const unsupported =
    (operation: string): Effect.Effect<never, TextGenerationError> =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail:
            "ACP Registry instances only provide orchestration plan generation; use OpenCode for other text generation.",
        }),
      );
  const planRunner = TextGenerationOperations.fromRunner(
    "AcpRegistryTextGeneration",
    TextGenerationOperations.withoutInvestigation("ACP Registry", (request) =>
      Effect.gen(function* () {
        const rawOutput = yield* options.provide(
          generateAcpText(options, {
            operation: request.operation,
            cwd: request.cwd,
            prompt: request.prompt,
            modelSelection: request.modelSelection,
          }),
        );
        return yield* TextGenerationOperations.decodeJsonReply(request, "ACP Registry", rawOutput);
      }),
    ),
  );
  return {
    generateOrchestrationPlan: planRunner.generateOrchestrationPlan,
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
    generateTranscriptionPostProcessing: () => unsupported("generateTranscriptionPostProcessing"),
  };
};
