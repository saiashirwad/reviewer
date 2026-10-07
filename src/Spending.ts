import { OpenAiClient } from "@effect/ai-openai-compat";
import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { AiError } from "effect/ai";
import * as budgetCore from "./budgetCore.ts";

export const PRICING: Readonly<Record<string, budgetCore.Pricing>> = {
  "deepseek-v4.1-flash": { input: 0.3, cached: 0.006, output: 1.2 },
  "deepseek-v4-flash": { input: 0.3, cached: 0.006, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, cached: 0.044, output: 3.96 },
  "glm-5.3-flash": { input: 0.15, cached: 0.03, output: 0.5 },
  "glm-5.3": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5.2": { input: 1.4, cached: 0.26, output: 4.4 },
  "kimi-k3": { input: 3, cached: 0.3, output: 15 },
  "kimi-k2.7-code": { input: 0.95, cached: 0.19, output: 4 },
  "kimi-k2.6": { input: 0.95, cached: 0.16, output: 4 },
  "longcat-2.0": { input: 0.3, cached: 0.006, output: 1.2 },
  "mimo-v2.6-flash": { input: 0.14, cached: 0.0028, output: 0.28 },
  "mimo-v2.6-pro": { input: 0.435, cached: 0.003625, output: 0.87 },
  "mimo-v2.5": { input: 0.14, cached: 0.0028, output: 0.28 },
  "mimo-v2.5-pro": { input: 0.435, cached: 0.003625, output: 0.87 },
  "hy4-preview": { input: 0.834, cached: 0.042, output: 2.501 },
  hy3: { input: 0.14, cached: 0.035, output: 0.58 },
};

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("UnknownModel", {
  model: Schema.String,
}) {
  override get message() {
    return `${this.model} has no known OpenCode Go chat-completions price. Supported: ${
      Object.keys(PRICING).join(", ")
    }`;
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const CHARS_PER_TOKEN = 3;

const normalizedUsage = (usage: OpenAiClient.ChatCompletionUsage): budgetCore.NormalizedUsage => {
  const details = usage.prompt_tokens_details;
  const cached = Predicate.isObject(details) && Predicate.hasProperty(details, "cached_tokens")
    ? Number(details.cached_tokens)
    : 0;
  return {
    input: usage.prompt_tokens,
    cached: Number.isFinite(cached) ? Math.min(cached, usage.prompt_tokens) : 0,
    output: usage.completion_tokens,
  };
};

const refusal = (description: string) =>
  AiError.make({
    module: "Spending",
    method: "admit",
    reason: AiError.InvalidRequestError.make({ description }),
  });

export const make = Effect.fn("Spending.make")(function*(options: {
  readonly model: string;
  readonly limitMicrousd: number;
}) {
  const pricing = PRICING[options.model];
  if (pricing === undefined) return yield* new UnknownModel({ model: options.model });

  const native = yield* OpenAiClient.OpenAiClient;
  const budget = yield* budgetCore.make({ pricing, limitMicrousd: options.limitMicrousd });

  const admit = Effect.fn("Spending.admit")(
    function*<P extends { readonly [key: string]: unknown; }>(payload: P) {
      const inputEstimate = Math.ceil(
        JSON.stringify([payload.messages, payload.tools ?? []]).length / CHARS_PER_TOKEN,
      );
      const requested = typeof payload.max_tokens === "number"
        ? payload.max_tokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
      const admitted = yield* budget.reserve(inputEstimate, requested);
      if (Option.isNone(admitted)) {
        yield* Effect.logInfo("Review spending limit reached", {
          limitMicrousd: options.limitMicrousd,
        });
        return yield* refusal("The review's spending limit is reached.");
      }
      const { maxOutputTokens, reservation } = admitted.value;
      return { payload: { ...payload, max_tokens: maxOutputTokens }, reservation };
    },
  );

  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native
        .createResponse(payload)
        .pipe(Effect.tapError(() => budget.settle(reservation, undefined)));
      const usage = result[0].usage;
      yield* budget.settle(
        reservation,
        usage ? normalizedUsage(usage) : undefined,
      );
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native
        .createResponseStream(payload)
        .pipe(Effect.tapError(() => budget.settle(reservation, undefined)));

      let usage: budgetCore.NormalizedUsage | undefined;
      return [
        response,
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event !== "[DONE]" && "usage" in event && event.usage) {
                usage = normalizedUsage(event.usage);
              }
            })
          ),
          Stream.ensuring(
            Effect.suspend(() => budget.settle(reservation, usage)),
          ),
        ),
      ] as const;
    }),
  });

  return { client, costControl: budget.costControl };
});
