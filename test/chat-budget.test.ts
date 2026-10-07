import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Result, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import * as OpenCode from "../src/OpenCode.ts";
import * as Spending from "../src/Spending.ts";
import { sseData, sseResponse } from "./support/sse.ts";

const model = "glm-5.3-flash";
const payload = {
  model,
  messages: [{ role: "user" as const, content: "Review this change" }],
  tools: [],
  max_tokens: 1000,
};

const clientLayer = OpenCode.chatClientLayer({
  apiKey: Redacted.make("test-key"),
  sessionId: "chat-budget-test",
});

const withFetch = (fetch: typeof globalThis.fetch) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(clientLayer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

const completion = (usage?: object) => ({
  id: "chat_test",
  model,
  created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  ...(usage === undefined ? {} : { usage }),
});

const usage = {
  prompt_tokens: 1000,
  completion_tokens: 50,
  total_tokens: 1050,
  prompt_tokens_details: { cached_tokens: 600 },
};

const chunk = (fields: object) => ({ id: "chat_stream", model, created: 1, ...fields });

it.effect("tiny chat budgets refuse before HTTP and do not count a model call", () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    throw new Error("Budget refusal must precede HTTP");
  };
  return Effect.gen(function*() {
    const budget = yield* Spending.make({ model, limitMicrousd: 100 });
    const result = yield* budget.client.createResponse(payload).pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: {
          _tag: "InvalidRequestError",
          description: "The review's spending limit is reached.",
        },
      },
    });
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.modelCalls).toBe(0);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(requests).toBe(0);
  }).pipe(withFetch(fetch));
});

it.effect("chat completion settles cached prompt tokens and actual output cost", () => {
  const fetch: typeof globalThis.fetch = async () => Response.json(completion(usage));
  return Effect.gen(function*() {
    const budget = yield* Spending.make({ model, limitMicrousd: 500_000 });
    yield* budget.client.createResponse(payload);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.cachedInputTokens).toBe(600);
    expect(snapshot.usage.uncachedInputTokens).toBe(400);
    expect(snapshot.usage.outputTokens).toBe(50);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(103);
  }).pipe(withFetch(fetch));
});

it.effect("chat request failure charges the full reservation", () => {
  const fetch: typeof globalThis.fetch = async () => Response.json({}, { status: 502 });
  return Effect.gen(function*() {
    const budget = yield* Spending.make({ model, limitMicrousd: 500_000 });
    expect(Result.isFailure(yield* budget.client.createResponse(payload).pipe(Effect.result)))
      .toBe(true);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.modelCalls).toBe(1);
    expect(snapshot.stopped).toBe(false);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(503);
  }).pipe(withFetch(fetch));
});

it.effect("concurrent chat calls cannot spend an outstanding reservation", () =>
  Effect.gen(function*() {
    let requests = 0;
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = async () => {
      requests++;
      Deferred.doneUnsafe(ready, Effect.void);
      await Effect.runPromise(Deferred.await(release));
      return Response.json(
        completion({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }),
      );
    };
    yield* Effect.gen(function*() {
      const budget = yield* Spending.make({ model, limitMicrousd: 600 });
      const first = yield* budget.client.createResponse(payload).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      expect((yield* budget.costControl.snapshot).usage.reservedCostMicrousd).toBe(503);
      const second = yield* budget.client.createResponse(payload).pipe(Effect.result);
      expect(Result.isFailure(second)).toBe(true);
      expect(requests).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      const snapshot = yield* budget.costControl.snapshot;
      expect(snapshot.stopped).toBe(true);
      expect(snapshot.modelCalls).toBe(1);
      expect(snapshot.usage.reservedCostMicrousd).toBe(0);
      expect(snapshot.usage.estimatedCostMicrousd).toBe(20);
    }).pipe(withFetch(fetch));
  }));

it.effect("unknown chat models fail before reserving budget", () =>
  Effect.gen(function*() {
    const error = yield* Spending.make({ model: "unknown-model", limitMicrousd: 500_000 }).pipe(
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "UnknownModel", model: "unknown-model" });
  }).pipe(Effect.provide(clientLayer)));

it.effect("chat streams settle actual usage from the final usage event", () => {
  const fetch: typeof globalThis.fetch = async () =>
    sseResponse([
      sseData(chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })),
      sseData(chunk({ choices: [], usage: { ...usage, completion_tokens: 1 } })),
      sseData(chunk({ choices: [], usage })),
      sseData("[DONE]"),
    ]);
  return Effect.gen(function*() {
    const budget = yield* Spending.make({ model, limitMicrousd: 500_000 });
    const [, stream] = yield* budget.client.createResponseStream(payload);
    yield* Stream.runDrain(stream);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.estimatedCostMicrousd).toBe(103);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
  }).pipe(withFetch(fetch));
});

it.effect("chat streams without usage charge the full reservation", () => {
  const fetch: typeof globalThis.fetch = async () =>
    sseResponse([
      sseData(chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })),
      sseData("[DONE]"),
    ]);
  return Effect.gen(function*() {
    const budget = yield* Spending.make({ model, limitMicrousd: 500_000 });
    const [, stream] = yield* budget.client.createResponseStream(payload);
    yield* Stream.runDrain(stream);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(503);
  }).pipe(withFetch(fetch));
});

it.effect("stopping chat stream consumption finalizes its reservation", () => {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData(chunk({
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          }))));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  return Effect.gen(function*() {
    const stop = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const budget = yield* Spending.make({ model, limitMicrousd: 500_000 });
    const [, stream] = yield* budget.client.createResponseStream(payload);
    const fiber = yield* stream.pipe(
      Stream.tap(() => Deferred.succeed(reading, undefined)),
      Stream.interruptWhen(Deferred.await(stop)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(reading);
    expect((yield* budget.costControl.snapshot).usage.reservedCostMicrousd).toBe(503);
    yield* Deferred.succeed(stop, undefined);
    yield* Fiber.join(fiber);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(503);
  }).pipe(withFetch(fetch));
});
