import { OpenAiClient, OpenAiSchema } from "@effect/ai-openai";
import { Effect, Option, Ref, Schema, Stream } from "effect";
import { AiError } from "effect/ai";
import { costControl, emptyTotals, settle, type Totals } from "./budgetCore.ts";
import type { Pricing } from "./budgetCore.ts";

export const MUSE_PRICING: Pricing = { input: 0.10, cached: 0.002, output: 0.20 };

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
  const cached =
    typeof details === "object" && details !== null && "cached_tokens" in details &&
      typeof details.cached_tokens === "number"
      ? Math.max(0, Math.min(details.cached_tokens, usage.input_tokens))
      : 0;
  return { input: usage.input_tokens, cached, output: usage.output_tokens };
};

export const make = Effect.fn("museBudget.make")(function* (limitMicrousd: number) {
  const native = yield* OpenAiClient.OpenAiClient;
  const totals = yield* Ref.make<Totals>(emptyTotals());
  const pricing = MUSE_PRICING;

  const admit = (original: Payload) =>
    Ref.modify(totals, (current): [Option.Option<{ payload: Payload; reservation: number }>, Totals] => {
      const inputBound = new TextEncoder().encode(JSON.stringify(original)).length + 4096;
      const balance = limitMicrousd - current.spent - current.reserved;
      const maxOutput = Math.min(
        original.max_output_tokens ?? 16_000,
        Math.floor((balance - inputBound * pricing.input) / pricing.output),
      );
      if (current.stopped || maxOutput < 256) {
        return [Option.none(), { ...current, stopped: true }];
      }
      const reservation = inputBound * pricing.input + maxOutput * pricing.output;
      return [
        Option.some({
          payload: {
            ...original,
            store: false,
            tool_choice: "auto" as const,
            max_output_tokens: maxOutput,
          },
          reservation,
        }),
        { ...current, modelCalls: current.modelCalls + 1, reserved: current.reserved + reservation },
      ];
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(refusal()),
          onSome: Effect.succeed,
        }),
      ),
    );

  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native.createResponse(payload).pipe(
        Effect.tapError(() => settle(totals, pricing, reservation, undefined)),
      );
      yield* settle(
        totals,
        pricing,
        reservation,
        result[0].usage ? usageBreakdown(result[0].usage) : undefined,
      );
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native.createResponseStream(payload).pipe(
        Effect.tapError((error) =>
          Effect.logError("OpenCode Responses request failed", { message: error.message }),
        ),
        Effect.tapError(() => settle(totals, pricing, reservation, undefined)),
      );

      let usage: Usage | undefined;
      return [
        response,
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (
                event.type === "response.completed" ||
                event.type === "response.incomplete" ||
                event.type === "response.failed"
              ) {
                const decoded = Schema.decodeUnknownOption(OpenAiSchema.Response)(event.response);
                if (Option.isSome(decoded)) usage = decoded.value.usage ?? undefined;
              }
            }),
          ),
          Stream.ensuring(
            Effect.suspend(() =>
              settle(totals, pricing, reservation, usage ? usageBreakdown(usage) : undefined),
            ),
          ),
        ),
      ] as const;
    }),
  });

  return { client, costControl: costControl(totals) };
});
