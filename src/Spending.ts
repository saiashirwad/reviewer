import { OpenAiClient } from "@effect/ai-openai-compat";
import { Review } from "@yielded/agent-pr-review";
import { Data, Effect, Option, Ref, Stream } from "effect";
import { AiError } from "effect/ai";

/**
 * Without spending admission the reviewer applies a cumulative 416k-token quota
 * that counts every resent prompt, cached or not, at full weight. A 21-file PR
 * exhausted it after ~7 calls while costing under five cents. Supplying a cost
 * controller replaces that quota with a per-review dollar limit.
 *
 * Prices are OpenCode Go's published per-model rates, which count against the
 * subscription's usage limits. USD per million tokens is microdollars per token.
 * DeepSeek models use their peak rates. See https://opencode.ai/docs/go/#usage-limits
 */
export interface Pricing {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

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

export class UnknownModel extends Data.TaggedError("UnknownModel")<{ readonly model: string }> {
  override get message() {
    return `${this.model} has no known OpenCode Go chat-completions price. Supported: ${Object.keys(PRICING).join(", ")}`;
  }
}

/** Requests without an explicit output cap are reserved at this many tokens. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
const MIN_OUTPUT_TOKENS = 256;
/** Conservative: real tokenizers average closer to four characters per token. */
const CHARS_PER_TOKEN = 3;

interface Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: unknown;
}

interface Totals {
  readonly stopped: boolean;
  readonly modelCalls: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly spent: number;
  readonly reserved: number;
}

const refusal = (description: string) =>
  AiError.make({
    module: "Spending",
    method: "admit",
    reason: AiError.InvalidRequestError.make({ description }),
  });

const cachedTokens = (usage: Usage) => {
  const details = usage.prompt_tokens_details;
  const cached =
    typeof details === "object" && details !== null && "cached_tokens" in details
      ? Number((details as { cached_tokens: unknown }).cached_tokens)
      : 0;
  return Number.isFinite(cached) ? Math.min(cached, usage.prompt_tokens) : 0;
};

/** Wrap the provided client so every call is admitted against one review's budget. */
export const make = Effect.fnUntraced(function* (options: {
  readonly model: string;
  readonly limitMicrousd: number;
}) {
  const pricing = PRICING[options.model];
  if (pricing === undefined) return yield* new UnknownModel({ model: options.model });

  const native = yield* OpenAiClient.OpenAiClient;
  const totals = yield* Ref.make<Totals>({
    stopped: false,
    modelCalls: 0,
    input: 0,
    cached: 0,
    output: 0,
    spent: 0,
    reserved: 0,
  });

  // The streaming request type is an Omit over an index signature, so only rely on
  // structural access to the fields that are priced.
  const admit = <P extends { readonly [key: string]: unknown }>(payload: P) =>
    Ref.modify(totals, (current): [Option.Option<{ payload: P; reservation: number }>, Totals] => {
      if (current.stopped) return [Option.none(), current];

      const inputEstimate = Math.ceil(
        JSON.stringify([payload.messages, payload.tools ?? []]).length / CHARS_PER_TOKEN,
      );
      const balance = options.limitMicrousd - current.spent - current.reserved;
      const affordable = Math.floor((balance - inputEstimate * pricing.input) / pricing.output);
      const requested =
        typeof payload.max_tokens === "number" ? payload.max_tokens : DEFAULT_MAX_OUTPUT_TOKENS;
      const maxTokens = Math.min(requested, affordable);

      if (maxTokens < MIN_OUTPUT_TOKENS) return [Option.none(), { ...current, stopped: true }];

      const reservation = inputEstimate * pricing.input + maxTokens * pricing.output;
      return [
        Option.some({ payload: { ...payload, max_tokens: maxTokens }, reservation }),
        { ...current, modelCalls: current.modelCalls + 1, reserved: current.reserved + reservation },
      ];
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logInfo("Review spending limit reached", {
              limitMicrousd: options.limitMicrousd,
            }).pipe(Effect.andThen(Effect.fail(refusal("The review's spending limit is reached.")))),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** Replace a reservation with the charge for the usage the provider reported. */
  const settle = (reservation: number, usage: Usage | undefined) =>
    Ref.update(totals, (current) => {
      if (usage === undefined) {
        return { ...current, reserved: current.reserved - reservation, spent: current.spent + reservation };
      }
      const cached = cachedTokens(usage);
      const cost =
        (usage.prompt_tokens - cached) * pricing.input +
        cached * pricing.cached +
        usage.completion_tokens * pricing.output;
      return {
        ...current,
        reserved: current.reserved - reservation,
        spent: current.spent + cost,
        input: current.input + usage.prompt_tokens,
        cached: current.cached + cached,
        output: current.output + usage.completion_tokens,
      };
    });

  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native
        .createResponse(payload)
        .pipe(Effect.tapError(() => settle(reservation, undefined)));
      yield* settle(reservation, result[0].usage ?? undefined);
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native
        .createResponseStream(payload)
        .pipe(Effect.tapError(() => settle(reservation, undefined)));

      let usage: Usage | undefined;
      return [
        response,
        stream.pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (typeof event === "object" && "usage" in event && event.usage) {
                usage = event.usage as Usage;
              }
            }),
          ),
          Stream.ensuring(Effect.suspend(() => settle(reservation, usage))),
        ),
      ] as const;
    }),
  });

  const costControl: Review.ReviewCostControl = {
    snapshot: Ref.get(totals).pipe(
      Effect.map((current) =>
        Review.ReviewCostSnapshot.make({
          stopped: current.stopped,
          modelCalls: current.modelCalls,
          usage: Review.ReviewUsage.make({
            inputTokens: current.input,
            uncachedInputTokens: current.input - current.cached,
            cachedInputTokens: current.cached,
            cacheWriteInputTokens: 0,
            outputTokens: current.output,
            estimatedCostMicrousd: Math.ceil(current.spent),
            reservedCostMicrousd: Math.ceil(current.reserved),
          }),
        }),
      ),
    ),
  };

  return { client, costControl };
});
