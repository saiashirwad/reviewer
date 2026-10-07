import { OpenAiClient } from "@effect/ai-openai-compat";
import { Data, Effect, Option, Ref, Stream } from "effect";
import { AiError } from "effect/ai";
import { costControl, emptyTotals, type Pricing, settle, type Totals } from "./budgetCore.ts";

export type { Pricing };

export const PRICING: Readonly<Record<string, Pricing>> = {
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

export class UnknownModel extends Data.TaggedError("UnknownModel")<{ readonly model: string; }> {
  override get message() {
    return `${this.model} has no known OpenCode Go chat-completions price. Supported: ${
      Object.keys(PRICING).join(", ")
    }`;
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const MIN_OUTPUT_TOKENS = 256;
const CHARS_PER_TOKEN = 3;

interface ChatUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: unknown;
}

const cachedTokens = (usage: ChatUsage) => {
  const details = usage.prompt_tokens_details;
  const cached = typeof details === "object" && details !== null && "cached_tokens" in details
    ? Number((details as { cached_tokens: unknown; }).cached_tokens)
    : 0;
  return Number.isFinite(cached) ? Math.min(cached, usage.prompt_tokens) : 0;
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
  const totals = yield* Ref.make<Totals>(emptyTotals());

  const admit = <P extends { readonly [key: string]: unknown; }>(payload: P) =>
    Ref.modify(totals, (current): [Option.Option<{ payload: P; reservation: number; }>, Totals] => {
      if (current.stopped) return [Option.none(), current];

      const inputEstimate = Math.ceil(
        JSON.stringify([payload.messages, payload.tools ?? []]).length / CHARS_PER_TOKEN,
      );
      const balance = options.limitMicrousd - current.spent - current.reserved;
      const affordable = Math.floor((balance - inputEstimate * pricing.input) / pricing.output);
      const requested = typeof payload.max_tokens === "number"
        ? payload.max_tokens
        : DEFAULT_MAX_OUTPUT_TOKENS;
      const maxTokens = Math.min(requested, affordable);

      if (maxTokens < MIN_OUTPUT_TOKENS) return [Option.none(), { ...current, stopped: true }];

      const reservation = inputEstimate * pricing.input + maxTokens * pricing.output;
      return [
        Option.some({ payload: { ...payload, max_tokens: maxTokens }, reservation }),
        {
          ...current,
          modelCalls: current.modelCalls + 1,
          reserved: current.reserved + reservation,
        },
      ];
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logInfo("Review spending limit reached", {
              limitMicrousd: options.limitMicrousd,
            }).pipe(
              Effect.andThen(Effect.fail(refusal("The review's spending limit is reached."))),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native
        .createResponse(payload)
        .pipe(Effect.tapError(() => settle(totals, pricing, reservation, undefined)));
      const usage = result[0].usage as ChatUsage | undefined;
      yield* settle(
        totals,
        pricing,
        reservation,
        usage
          ? {
            input: usage.prompt_tokens,
            cached: cachedTokens(usage),
            output: usage.completion_tokens,
          }
          : undefined,
      );
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function*(original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native
        .createResponseStream(payload)
        .pipe(Effect.tapError(() => settle(totals, pricing, reservation, undefined)));

      let usage: ChatUsage | undefined;
      return [
        response,
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (typeof event === "object" && event !== null && "usage" in event && event.usage) {
                usage = event.usage as ChatUsage;
              }
            })
          ),
          Stream.ensuring(
            Effect.suspend(() =>
              settle(
                totals,
                pricing,
                reservation,
                usage
                  ? {
                    input: usage.prompt_tokens,
                    cached: cachedTokens(usage),
                    output: usage.completion_tokens,
                  }
                  : undefined,
              )
            ),
          ),
        ),
      ] as const;
    }),
  });

  return { client, costControl: costControl(totals) };
});
