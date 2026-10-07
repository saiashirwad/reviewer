import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from "@effect/ai-openai";
import { Review } from "@yielded/agent-pr-review";
import { Effect, Layer, Option, Ref, type Redacted, Schema, Stream } from "effect";
import { AiError } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { OPENCODE_GO_API_URL } from "./Model.ts";

export const MUSE_MODEL = "muse-spark-1.3-contributor";
const PRICE = { input: 0.10, cached: 0.002, output: 0.20 };

type Payload = Parameters<OpenAiClient.Service["createResponse"]>[0];
type Response = Effect.Success<ReturnType<OpenAiClient.Service["createResponse"]>>[0];
type Usage = NonNullable<Response["usage"]>;

export const clientLayer = (apiKey: Redacted.Redacted<string>, sessionId: string) =>
  OpenAiClient.layer({
    apiKey,
    apiUrl: OPENCODE_GO_API_URL,
    transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders({
      "user-agent": "reviewer/0.1",
      "x-opencode-session": sessionId,
    })),
  }).pipe(Layer.provide(FetchHttpClient.layer));

const refusal = () => AiError.make({
  module: "Responses",
  method: "admit",
  reason: AiError.InvalidRequestError.make({ description: "Review spending limit reached." }),
});

export const make = Effect.fnUntraced(function* (limitMicrousd: number) {
  const native = yield* OpenAiClient.OpenAiClient;
  const totals = yield* Ref.make({
    stopped: false, modelCalls: 0, input: 0, cached: 0, output: 0, spent: 0, reserved: 0,
  });
  const admit = Effect.fnUntraced(function* (original: Payload) {
    const before = yield* Ref.get(totals);
    // Reserve one token per UTF-8 byte plus overhead. This intentionally ignores
    // cache discounts before dispatch; settle using reported cache hits afterward.
    const inputBound = new TextEncoder().encode(JSON.stringify(original)).length + 4096;
    const balance = limitMicrousd - before.spent - before.reserved;
    const maxOutput = Math.min(original.max_output_tokens ?? 16_000,
      Math.floor((balance - inputBound * PRICE.input) / PRICE.output));
    if (before.stopped || maxOutput < 256) {
      yield* Ref.update(totals, (state) => ({ ...state, stopped: true }));
      return yield* refusal();
    }
    const reservation = inputBound * PRICE.input + maxOutput * PRICE.output;
    yield* Ref.update(totals, (state) => ({ ...state,
      modelCalls: state.modelCalls + 1, reserved: state.reserved + reservation }));
    // Muse only accepts automatic tool selection. Keep the toolkit and Yielded's
    // completion validation, but never send required or named tool choices.
    return { payload: { ...original, store: false, tool_choice: "auto" as const,
      max_output_tokens: maxOutput }, reservation };
  });
  const settle = (reservation: number, usage: Usage | undefined) =>
    Ref.update(totals, (state) => {
      if (!usage) return { ...state, spent: state.spent + reservation,
        reserved: state.reserved - reservation };
      const details = usage.input_tokens_details;
      const cached = typeof details === "object" && details !== null &&
        "cached_tokens" in details && typeof details.cached_tokens === "number"
        ? Math.max(0, Math.min(details.cached_tokens, usage.input_tokens)) : 0;
      const cost = (usage.input_tokens - cached) * PRICE.input + cached * PRICE.cached +
        usage.output_tokens * PRICE.output;
      return { ...state, spent: state.spent + cost, reserved: state.reserved - reservation,
        input: state.input + usage.input_tokens, cached: state.cached + cached,
        output: state.output + usage.output_tokens };
    });
  const client = OpenAiClient.OpenAiClient.of({
    ...native,
    createResponse: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const result = yield* native.createResponse(payload).pipe(
        Effect.tapError(() => settle(reservation, undefined)));
      yield* settle(reservation, result[0].usage ?? undefined);
      return result;
    }),
    createResponseStream: Effect.fnUntraced(function* (original) {
      const { payload, reservation } = yield* admit(original);
      const [response, stream] = yield* native.createResponseStream(payload).pipe(
        Effect.tapError((error) => Effect.logError("OpenCode Responses request failed", {
          message: error.message,
        })),
        Effect.tapError(() => settle(reservation, undefined)));
      let usage: Usage | undefined;
      return [response, stream.pipe(
        Stream.tap((event) => Effect.sync(() => {
          if (event.type === "response.completed" || event.type === "response.incomplete" ||
            event.type === "response.failed") {
            const decoded = Schema.decodeUnknownOption(OpenAiSchema.Response)(event.response);
            if (Option.isSome(decoded)) usage = decoded.value.usage ?? undefined;
          }
        })),
        Stream.ensuring(Effect.suspend(() => settle(reservation, usage))),
      )] as const;
    }),
  });
  const costControl: Review.ReviewCostControl = {
    snapshot: Ref.get(totals).pipe(Effect.map((state) => Review.ReviewCostSnapshot.make({
      stopped: state.stopped, modelCalls: state.modelCalls,
      usage: Review.ReviewUsage.make({ inputTokens: state.input,
        uncachedInputTokens: state.input - state.cached, cachedInputTokens: state.cached,
        cacheWriteInputTokens: 0, outputTokens: state.output,
        estimatedCostMicrousd: Math.ceil(state.spent),
        reservedCostMicrousd: Math.max(0, Math.ceil(state.reserved)) }),
    }))),
  };
  return { client, costControl };
});

export const review = Effect.fnUntraced(function* (options: {
  readonly request: Review.ReviewRequest;
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
  readonly limitMicrousd: number;
  readonly guidance: string | undefined;
}) {
  const spending = yield* make(options.limitMicrousd).pipe(
    Effect.provide(clientLayer(options.apiKey, options.sessionId)));
  return yield* Review.makeReviewer({
    model: OpenAiLanguageModel.model(MUSE_MODEL, { useItemReferences: false }),
    costControl: spending.costControl,
    contextTokenLimit: 128_000,
    guidance: options.guidance,
  }).review(options.request).pipe(
    Effect.provide(Layer.succeed(OpenAiClient.OpenAiClient, spending.client)));
});
