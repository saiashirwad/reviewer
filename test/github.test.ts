import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { GitHub, layer } from "../src/GitHub.ts";

const pullRef = { owner: "acme", repository: "widget", number: 42 };
const marker = "<!-- reviewer:page-two-head -->";

it.effect("reviewBodies finds review markers past the first 100 reviews", () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page === 1) {
      return Response.json(Array.from({ length: 100 }, (_, i) => ({
        body: i % 3 === 0 ? null : `noise-${i}`,
      })));
    }
    expect(page).toBe(2);
    return Response.json([{ body: marker }]);
  };

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const bodies = yield* github.reviewBodies(pullRef);
    expect(bodies.at(-1)).toBe("<!-- reviewer:page-two-head -->");
    expect(bodies.length).toBe(67);
    expect(bodies[0]).toBe("noise-1");
  }).pipe(
    Effect.provide(layer(Redacted.make("dummy-token"))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});
