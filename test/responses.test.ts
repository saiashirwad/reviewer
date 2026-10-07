import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import * as museBudget from "../src/museBudget.ts";
import * as OpenCode from "../src/OpenCode.ts";

it.effect("Muse uses Responses, stable session headers, auto tools, and cached usage accounting", () => {
  const requests: Array<{ url: string; headers: Headers; body: unknown; }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: await request.json(),
    });
    return Response.json({
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      model: OpenCode.MUSE_MODEL,
      output: [],
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_tokens_details: { cached_tokens: 800 },
      },
    });
  };
  return Effect.gen(function*() {
    const budget = yield* museBudget.make(500_000);
    yield* budget.client.createResponse({
      model: OpenCode.MUSE_MODEL,
      input: "Review this change",
      tool_choice: "required",
      tools: [],
      max_output_tokens: 1000,
    });
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.cachedInputTokens).toBe(800);
    expect(snapshot.usage.uncachedInputTokens).toBe(200);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(42);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    const request = requests[0];
    if (request === undefined) return yield* Effect.die("No Responses request was sent");
    expect(request.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(request.headers.get("x-opencode-session")).toBe("pr23-head");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(request.body).toMatchObject({ tool_choice: "auto", store: false });
  }).pipe(
    Effect.provide(
      OpenCode.responsesClientLayer({ apiKey: Redacted.make("test-key"), sessionId: "pr23-head" }),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});
