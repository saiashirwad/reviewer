import { expect, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import * as museBudget from "../src/museBudget.ts";
import * as OpenCode from "../src/OpenCode.ts";

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
