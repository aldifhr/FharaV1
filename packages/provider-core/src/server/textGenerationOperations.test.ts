import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@fhara/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: plan generation must reach the model with the registered role catalog and decode the plan back
it.effect("generates an orchestration plan through a captured runner", () =>
  Effect.gen(function* () {
    const captured: Array<{ operation: string; prompt: string }> = [];
    const textGeneration = fromRunner("Stub", (request) => {
      captured.push({ operation: request.operation, prompt: request.prompt });
      return decodeJsonReply(
        request,
        "Stub",
        '{"summary":"Do the thing","steps":[{"id":"step-1","roleId":"backend","task":"Add the endpoint","dependsOn":[],"requiresApproval":true}]}',
      );
    });

    const result = yield* textGeneration.generateOrchestrationPlan({
      cwd: process.cwd(),
      prompt: "Build the playground backend",
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/claude-haiku-4-5",
      },
    });

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0]!.operation, "generateOrchestrationPlan");
    assert.include(captured[0]!.prompt, "backend");
    assert.include(captured[0]!.prompt, "Build the playground backend");
    assert.deepEqual(result, {
      summary: "Do the thing",
      steps: [
        {
          id: "step-1",
          roleId: "backend",
          task: "Add the endpoint",
          dependsOn: [],
          requiresApproval: true,
        },
      ],
    });
  }),
);

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);
