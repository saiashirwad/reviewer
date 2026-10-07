import { OpenAiClient, OpenAiSchema } from "@effect/ai-openai";
import { Effect, Option, Schema, Stream } from "effect";
import { AiError } from "effect/ai";
import * as budgetCore from "./budgetCore.ts";

export const MUSE_PRICING: budgetCore.Pricing = { input: 0.10, cached: 0.002, output: 0.20 };

type Payload = Parameters<OpenAiClient.Service["createResponse"]>[0];
type Response = Effect.Success<ReturnType<OpenAiClient.Service["createResponse"]>>[0];
type Usage = NonNullable<Response["usage"]>;

const refusal = () =>
  AiError.make({
    module: "museBudget",
    method: "admit",
    reason: AiError.InvalidRequestError.make({ description: "Review spending limit reached." }),
  });

const usageBreakdown = (usage: Usage) => {
  const details = usage.input_tokens_details;
  const cached = typeof details === "object" && details !== null && "cached_tokens" in details
      && typeof details.cached_tokens === "number"
    ? Math.max(0, Math.min(details.cached_tokens, usage.input_tokens))
    : 0;
  return { input: usage.input_tokens, cached, output: usage.output_tokens };
};

export const make = Effect.fn("museBudget.make")(function*(limitMicrousd: number) {
  const native = yield* OpenAiClient.OpenAiClient;
  const budget = yield* budgetCore.make({ pricing: MUSE_PRICING, limitMicrousd });

  const admit = Effect.fn("museBudget.admit")(function*(original: Payload) {
    const inputBound = new TextEncoder().encode(JSON.stringify(original)).length + 4096;
    const admitted = yield* budget.reserve(inputBound, original.max_output_tokens ?? 16_000);
    if (Option.isNone(admitted)) return yield* refusal();
    const { maxOutputTokens, reservation } = admitted.value;
    return {
      payload: {
        ...original,
        store: false,
        tool_choice: "auto" as const,
        max_output_tokens: maxOutputTokens,
      },
      reservation,
    };
  });

  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native.createResponse(payload).pipe(
        Effect.tapError(() => budget.settle(reservation, undefined)),
      );
      yield* budget.settle(
        reservation,
        result[0].usage ? usageBreakdown(result[0].usage) : undefined,
      );
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native.createResponseStream(payload).pipe(
        Effect.tapError((error) =>
          Effect.logError("OpenCode Responses request failed", { message: error.message })
        ),
        Effect.tapError(() => budget.settle(reservation, undefined)),
      );

      let usage: Usage | undefined;
      return [
        response,
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (
                event.type === "response.completed"
                || event.type === "response.incomplete"
                || event.type === "response.failed"
              ) {
                const decoded = Schema.decodeUnknownOption(OpenAiSchema.Response)(event.response);
                if (Option.isSome(decoded)) usage = decoded.value.usage ?? undefined;
              }
            })
          ),
          Stream.ensuring(
            Effect.suspend(() =>
              budget.settle(reservation, usage ? usageBreakdown(usage) : undefined)
            ),
          ),
        ),
      ] as const;
    }),
  });

  return { client, costControl: budget.costControl };
});
