import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Result, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import * as museBudget from "../src/museBudget.ts";
import * as OpenCode from "../src/OpenCode.ts";
import { sseData, sseResponse } from "./support/sse.ts";

const samplePayload = {
  model: OpenCode.MUSE_MODEL,
  input: "Review this change",
  tool_choice: "required" as const,
  tools: [],
  max_output_tokens: 1000,
};

const clientLayer = OpenCode.responsesClientLayer({
  apiKey: Redacted.make("test-key"),
  sessionId: "budget-test",
});

it.effect("exhausted tiny Muse budget refuses before any HTTP fetch", () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    throw new Error("Budget refusal must precede HTTP requests");
  };

  return Effect.gen(function*() {
    const budget = yield* museBudget.make(100);
    const callResult = yield* budget.client.createResponse(samplePayload).pipe(Effect.result);
    const snapshot = yield* budget.costControl.snapshot;

    expect(callResult).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: { _tag: "InvalidRequestError", description: "Review spending limit reached." },
      },
    });
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.modelCalls).toBe(0);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(requests).toBe(0);
  }).pipe(Effect.provide(clientLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

it.effect("fetch failure after admission settles reservation and charges conservative cost", () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: "upstream failed" }, { status: 502 });
  };

  return Effect.gen(function*() {
    const budget = yield* museBudget.make(500_000);
    const callResult = yield* budget.client.createResponse(samplePayload).pipe(Effect.result);
    const snapshot = yield* budget.costControl.snapshot;

    expect(Result.isFailure(callResult)).toBe(true);
    expect(snapshot.modelCalls).toBe(1);
    expect(snapshot.stopped).toBe(false);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(623);
    expect(requests).toBe(1);
  }).pipe(Effect.provide(clientLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

const completed = (usage?: object) => ({
  type: "response.completed",
  response: {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: OpenCode.MUSE_MODEL,
    output: [],
    ...(usage === undefined ? {} : { usage }),
  },
});

it.effect("Muse streams settle actual usage from the terminal response", () => {
  const fetch: typeof globalThis.fetch = async () =>
    sseResponse([sseData(completed({
      input_tokens: 1000,
      output_tokens: 100,
      total_tokens: 1100,
      input_tokens_details: { cached_tokens: 800 },
    }))]);
  return Effect.gen(function*() {
    const budget = yield* museBudget.make(500_000);
    const [, stream] = yield* budget.client.createResponseStream(samplePayload);
    yield* Stream.runDrain(stream);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.estimatedCostMicrousd).toBe(42);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
  }).pipe(Effect.provide(clientLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

it.effect("Muse streams without usage charge the full reservation", () => {
  const fetch: typeof globalThis.fetch = async () => sseResponse([sseData(completed())]);
  return Effect.gen(function*() {
    const budget = yield* museBudget.make(500_000);
    const [, stream] = yield* budget.client.createResponseStream(samplePayload);
    yield* Stream.runDrain(stream);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(623);
  }).pipe(Effect.provide(clientLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

it.effect("stopping Muse stream consumption finalizes its reservation", () => {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData({
            type: "response.created",
            response: completed().response,
          })));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  return Effect.gen(function*() {
    const stop = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const budget = yield* museBudget.make(500_000);
    const [, stream] = yield* budget.client.createResponseStream(samplePayload);
    const fiber = yield* stream.pipe(
      Stream.tap(() => Deferred.succeed(reading, undefined)),
      Stream.interruptWhen(Deferred.await(stop)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(reading);
    expect((yield* budget.costControl.snapshot).usage.reservedCostMicrousd).toBe(623);
    yield* Deferred.succeed(stop, undefined);
    yield* Fiber.join(fiber);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(623);
  }).pipe(Effect.provide(clientLayer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});
