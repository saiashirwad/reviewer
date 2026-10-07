import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as Responses from "../src/Responses.ts";

// Exercise the actual Effect OpenAI client through a local HTTP transport.
test("Muse uses Responses, stable session headers, auto tools, and cached usage accounting", async () => {
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) });
    return Response.json({
      id: "resp_test", object: "response", created_at: 1, status: "completed",
      model: Responses.MUSE_MODEL, output: [],
      usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100,
        input_tokens_details: { cached_tokens: 800 } },
    });
  };
  const program = Effect.gen(function* () {
    const budget = yield* Responses.make(500_000);
    yield* budget.client.createResponse({ model: Responses.MUSE_MODEL, input: "Review this change",
      tool_choice: "required", tools: [], max_output_tokens: 1000 });
    const snapshot = yield* budget.costControl.snapshot;
    assert.equal(snapshot.modelCalls, 1);
    assert.equal(snapshot.usage.cachedInputTokens, 800);
    assert.equal(snapshot.usage.uncachedInputTokens, 200);
    assert.equal(snapshot.usage.estimatedCostMicrousd, 42);
    assert.equal(snapshot.usage.reservedCostMicrousd, 0);
  }).pipe(
    Effect.provide(Responses.clientLayer(Redacted.make("test-key"), "pr23-head")),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  await Effect.runPromise(program);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(request.headers.get("x-opencode-session"), "pr23-head");
  assert.equal(request.headers.get("user-agent"), "reviewer/0.1");
  assert.equal(request.headers.get("authorization"), "Bearer test-key");
  assert.deepEqual(request.body, {
    model: Responses.MUSE_MODEL, input: "Review this change", tool_choice: "auto",
    tools: [], max_output_tokens: 1000, store: false,
  });
});
