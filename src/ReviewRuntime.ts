import { OpenAiClient as OpenAiClientResponses, OpenAiLanguageModel } from "@effect/ai-openai";
import { OpenAiClient as OpenAiClientChat } from "@effect/ai-openai-compat";
import { Review } from "@yielded/agent-pr-review";
import { ReviewRepository } from "@yielded/agent-pr-review/review-repository";
import { Effect, type Redacted } from "effect";
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

interface Options {
  readonly request: Review.ReviewRequest;
  readonly snapshot: Snapshot;
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
  readonly model: string;
  readonly limitMicrousd: number;
  readonly guidance: string | undefined;
}

const skip = (reason: string): ReviewRun => ({ _tag: "Skipped", reason });

const skipFromReviewError = (error: unknown): ReviewRun => {
  if (error instanceof Spending.UnknownModel) return skip(error.message);
  if (AiError.isAiError(error) && error.reason._tag === "InvalidRequestError") {
    return skip(error.reason.description ?? "Review request refused.");
  }
  return skip(error instanceof Error ? error.message : String(error));
};

const runChatReview = Effect.fnUntraced(function*(options: Options) {
  const spending = yield* Spending.make({
    model: options.model,
    limitMicrousd: options.limitMicrousd,
  }).pipe(
    Effect.provide(
      OpenCode.chatClientLayer({ apiKey: options.apiKey, sessionId: options.sessionId }),
    ),
  );

  const { review } = Review.makeReviewer({
    model: OpenCode.model(options.model),
    guidance: options.guidance,
    contextTokenLimit: CONTEXT_TOKEN_LIMIT,
    costControl: spending.costControl,
  });

  return yield* review(options.request).pipe(
    Effect.provideService(ReviewRepository, ReviewContext.make(options.snapshot)),
    Effect.provideService(OpenAiClientChat.OpenAiClient, spending.client),
  );
});

const runMuseReview = Effect.fnUntraced(function*(options: Options) {
  const spending = yield* museBudget.make(options.limitMicrousd).pipe(
    Effect.provide(
      OpenCode.responsesClientLayer({ apiKey: options.apiKey, sessionId: options.sessionId }),
    ),
  );

  const { review } = Review.makeReviewer({
    model: OpenAiLanguageModel.model(OpenCode.MUSE_MODEL, { useItemReferences: false }),
    costControl: spending.costControl,
    contextTokenLimit: CONTEXT_TOKEN_LIMIT,
    guidance: options.guidance,
  });

  return yield* review(options.request).pipe(
    Effect.provideService(ReviewRepository, ReviewContext.make(options.snapshot)),
    Effect.provideService(OpenAiClientResponses.OpenAiClient, spending.client),
  );
});

export const runReview = Effect.fn("ReviewRuntime.runReview")(
  function*(options: Options) {
    if (OpenCode.transportForModel(options.model) === "responses") {
      return yield* runMuseReview(options);
    }
    return yield* runChatReview(options);
  },
  Effect.map((outcome): ReviewRun => ({ _tag: "Completed", outcome })),
  Effect.catch((error) => Effect.succeed(skipFromReviewError(error))),
);
