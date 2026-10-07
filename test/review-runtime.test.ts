import { OpenAiClient as ResponsesClient } from "@effect/ai-openai";
import { OpenAiClient as ChatClient } from "@effect/ai-openai-compat";
import { expect, it } from "@effect/vitest";
import { Review } from "@yielded/agent-pr-review";
import { ReviewRepository } from "@yielded/agent-pr-review/review-repository";
import { Cause, Deferred, Effect, Exit, Fiber, Redacted } from "effect";
import { AiError } from "effect/ai";
import { afterEach, vi } from "vitest";
import * as OpenCode from "../src/OpenCode.ts";
import * as ReviewRuntime from "../src/ReviewRuntime.ts";
import { fromMaps } from "../src/snapshot/types.ts";

const makeReviewer = vi.hoisted(() => vi.fn());
const museModel = vi.hoisted(() => vi.fn());

vi.mock("@effect/ai-openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/ai-openai")>();
  const model: typeof actual.OpenAiLanguageModel.model = (...args) => {
    museModel(...args);
    return actual.OpenAiLanguageModel.model(...args);
  };
  return { ...actual, OpenAiLanguageModel: { ...actual.OpenAiLanguageModel, model } };
});

vi.mock("@yielded/agent-pr-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yielded/agent-pr-review")>();
  return { ...actual, Review: { ...actual.Review, makeReviewer } };
});

afterEach(() => {
  makeReviewer.mockReset();
  museModel.mockReset();
});

const outcome = Review.ReviewOutcome.make({
  report: Review.ReviewReport.make({ summary: "ok", findings: [] }),
  turns: 1,
  usage: Review.ReviewUsage.make({
    inputTokens: 1,
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
  }),
});

const options: Parameters<typeof ReviewRuntime.runReview>[0] = {
  request: Review.ReviewRequest.make({
    title: "Test",
    description: "Test review",
    baseRevision: "base",
    headRevision: "head",
    changes: [],
    unreviewedPaths: [],
  }),
  snapshot: fromMaps({ base: new Map(), head: new Map() }),
  apiKey: Redacted.make("test-key"),
  sessionId: "review-runtime-test",
  model: "glm-5.3-flash",
  limitMicrousd: 500_000,
  guidance: undefined,
};

it.effect("unknown chat models skip before creating a reviewer", () =>
  Effect.gen(function*() {
    expect(yield* ReviewRuntime.runReview({ ...options, model: "unknown-model" })).toMatchObject({
      _tag: "Skipped",
      reason: expect.stringContaining("unknown-model"),
    });
    expect(makeReviewer).not.toHaveBeenCalled();
  }));

for (const model of [options.model, OpenCode.MUSE_MODEL]) {
  it.effect(`${model} maps successful review outcomes and preserves reviewer configuration`, () =>
    Effect.gen(function*() {
      makeReviewer.mockReturnValue({ review: () => Effect.succeed(outcome) });
      expect(yield* ReviewRuntime.runReview({ ...options, model, guidance: "Check boundaries" }))
        .toEqual({ _tag: "Completed", outcome });
      expect(makeReviewer).toHaveBeenCalledWith(expect.objectContaining({
        guidance: "Check boundaries",
        contextTokenLimit: 128_000,
        costControl: expect.objectContaining({ snapshot: expect.anything() }),
      }));
      if (model === OpenCode.MUSE_MODEL) {
        expect(museModel).toHaveBeenCalledWith(model, { useItemReferences: false });
      }
    }));

  it.effect(`${model} maps invalid request failures to their refusal descriptions`, () =>
    Effect.gen(function*() {
      makeReviewer.mockReturnValue({
        review: () =>
          Effect.fail(AiError.make({
            module: "test",
            method: "review",
            reason: AiError.InvalidRequestError.make({ description: "context too large" }),
          })),
      });
      expect(yield* ReviewRuntime.runReview({ ...options, model }))
        .toEqual({ _tag: "Skipped", reason: "context too large" });
    }));
}

it.effect("generic typed review failures retain their message", () =>
  Effect.gen(function*() {
    makeReviewer.mockReturnValue({ review: () => Effect.fail(new Error("upstream failed")) });
    expect(yield* ReviewRuntime.runReview(options))
      .toEqual({ _tag: "Skipped", reason: "upstream failed" });
  }));

it.effect("chat review receives the budgeted chat client", () =>
  Effect.gen(function*() {
    makeReviewer.mockReturnValue({
      review: () =>
        Effect.gen(function*() {
          const client = yield* ChatClient.OpenAiClient;
          const error = yield* client.createResponse({
            model: options.model,
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          }).pipe(Effect.flip);
          expect(error).toMatchObject({ reason: { _tag: "InvalidRequestError" } });
          return outcome;
        }),
    });
    expect(yield* ReviewRuntime.runReview({ ...options, limitMicrousd: 100 }))
      .toEqual({ _tag: "Completed", outcome });
  }));

it.effect("Muse review receives the budgeted Responses client", () =>
  Effect.gen(function*() {
    makeReviewer.mockReturnValue({
      review: () =>
        Effect.gen(function*() {
          const client = yield* ResponsesClient.OpenAiClient;
          const error = yield* client.createResponse({ model: OpenCode.MUSE_MODEL, input: "hello" })
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: { _tag: "InvalidRequestError" } });
          return outcome;
        }),
    });
    expect(
      yield* ReviewRuntime.runReview({
        ...options,
        model: OpenCode.MUSE_MODEL,
        limitMicrousd: 100,
      }),
    ).toEqual({ _tag: "Completed", outcome });
  }));

it.effect("review defects do not become skipped results", () =>
  Effect.gen(function*() {
    makeReviewer.mockReturnValue({ review: () => Effect.die("review defect") });
    const exit = yield* ReviewRuntime.runReview(options).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
  }));

it.effect("in-flight review interruption does not become a skipped result", () =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<void>();
    makeReviewer.mockReturnValue({
      review: () =>
        Effect.gen(function*() {
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
    });
    const fiber = yield* ReviewRuntime.runReview(options).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }));

it.effect("review receives the repository backed by the supplied snapshot", () =>
  Effect.gen(function*() {
    makeReviewer.mockReturnValue({
      review: () =>
        Effect.gen(function*() {
          const repository = yield* ReviewRepository;
          const listed = yield* repository.findFiles({ query: "a.ts", revision: "head" });
          expect(listed.paths).toEqual(["src/a.ts"]);
          return outcome;
        }),
    });
    expect(
      yield* ReviewRuntime.runReview({
        ...options,
        snapshot: fromMaps({ base: new Map(), head: new Map([["src/a.ts", "hello"]]) }),
      }),
    ).toEqual({ _tag: "Completed", outcome });
  }));
