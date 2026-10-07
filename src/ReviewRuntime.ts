import { OpenAiClient as OpenAiClientResponses, OpenAiLanguageModel } from "@effect/ai-openai";
import { OpenAiClient as OpenAiClientChat } from "@effect/ai-openai-compat";
import { Review } from "@yielded/agent-pr-review";
import { Effect, Layer, type Redacted, Result } from "effect";
import { AiError } from "effect/ai";
import * as museBudget from "./museBudget.ts";
import * as OpenCode from "./OpenCode.ts";
import * as ReviewContext from "./ReviewContext.ts";
import type { Snapshot } from "./snapshot/types.ts";
import * as Spending from "./Spending.ts";

const CONTEXT_TOKEN_LIMIT = 128_000;

export type ReviewRun =
  | { readonly _tag: "Completed"; readonly outcome: Review.ReviewOutcome; }
  | { readonly _tag: "Skipped"; readonly reason: string; };

const skip = (reason: string): ReviewRun => ({ _tag: "Skipped", reason });

const skipFromReviewError = (error: unknown): ReviewRun => {
  if (error instanceof Spending.UnknownModel) return skip(error.message);
  if (AiError.isAiError(error) && error.reason._tag === "InvalidRequestError") {
    return skip(error.reason.description ?? "Review request refused.");
  }
  return skip(error instanceof Error ? error.message : String(error));
};

const runChatReview = Effect.fnUntraced(function*(options: {
  readonly request: Review.ReviewRequest;
  readonly snapshot: Snapshot;
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
  readonly model: string;
  readonly limitMicrousd: number;
  readonly guidance: string | undefined;
}) {
  const spendingResult = yield* Spending.make({
    model: options.model,
    limitMicrousd: options.limitMicrousd,
  }).pipe(
    Effect.provide(
      OpenCode.chatClientLayer({ apiKey: options.apiKey, sessionId: options.sessionId }),
    ),
    Effect.result,
  );

  if (Result.isFailure(spendingResult)) return skipFromReviewError(spendingResult.failure);
  const spending = spendingResult.success;

  const { review } = Review.makeReviewer({
    model: OpenCode.model(options.model),
    guidance: options.guidance,
    contextTokenLimit: CONTEXT_TOKEN_LIMIT,
    costControl: spending.costControl,
  });

  const outcomeResult = yield* review(options.request).pipe(
    Effect.provide(
      Layer.mergeAll(
        ReviewContext.layer(options.snapshot),
        Layer.succeed(OpenAiClientChat.OpenAiClient, spending.client),
      ),
    ),
    Effect.result,
  );

  if (Result.isFailure(outcomeResult)) return skipFromReviewError(outcomeResult.failure);
  return { _tag: "Completed", outcome: outcomeResult.success } satisfies ReviewRun;
});

const runMuseReview = Effect.fnUntraced(function*(options: {
  readonly request: Review.ReviewRequest;
  readonly snapshot: Snapshot;
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
  readonly limitMicrousd: number;
  readonly guidance: string | undefined;
}) {
  const spendingResult = yield* museBudget.make(options.limitMicrousd).pipe(
    Effect.provide(
      OpenCode.responsesClientLayer({ apiKey: options.apiKey, sessionId: options.sessionId }),
    ),
    Effect.result,
  );

  if (Result.isFailure(spendingResult)) return skipFromReviewError(spendingResult.failure);
  const spending = spendingResult.success;

  const { review } = Review.makeReviewer({
    model: OpenAiLanguageModel.model(OpenCode.MUSE_MODEL, { useItemReferences: false }),
    costControl: spending.costControl,
    contextTokenLimit: CONTEXT_TOKEN_LIMIT,
    guidance: options.guidance,
  });

  const outcomeResult = yield* review(options.request).pipe(
    Effect.provide(
      Layer.mergeAll(
        ReviewContext.layer(options.snapshot),
        Layer.succeed(OpenAiClientResponses.OpenAiClient, spending.client),
      ),
    ),
    Effect.result,
  );

  if (Result.isFailure(outcomeResult)) return skipFromReviewError(outcomeResult.failure);
  return { _tag: "Completed", outcome: outcomeResult.success } satisfies ReviewRun;
});

export const runReview = Effect.fn("ReviewRuntime.runReview")(function*(options: {
  readonly request: Review.ReviewRequest;
  readonly snapshot: Snapshot;
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
  readonly model: string;
  readonly limitMicrousd: number;
  readonly guidance: string | undefined;
}) {
  if (OpenCode.transportForModel(options.model) === "responses") {
    return yield* runMuseReview(options);
  }
  return yield* runChatReview(options);
});
