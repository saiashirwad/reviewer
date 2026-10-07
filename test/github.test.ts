import { expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChangedFile, GitHub, GitHubError, layer } from "../src/GitHub.ts";

const pullRef = { owner: "acme", repository: "widget", number: 42 };
const repoRef = { owner: "acme", repository: "widget" };
const marker = "<!-- reviewer:page-two-head -->";

const withFetch = (fetch: typeof globalThis.fetch) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(layer(Redacted.make("dummy-token"))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

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
    expect(bodies.at(-1)).toBe(marker);
    expect(bodies.length).toBe(67);
    expect(bodies[0]).toBe("noise-1");
  }).pipe(withFetch(fetch));
});

it.effect("reviewBodies stops pagination on a short raw page, not filtered body count", () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (page === 1) {
      return Response.json(Array.from({ length: 100 }, () => ({ body: null })));
    }
    expect(page).toBe(2);
    return Response.json([{ body: "" }, { body: "tail" }]);
  };

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const bodies = yield* github.reviewBodies(pullRef);
    expect(bodies).toEqual(["tail"]);
  }).pipe(withFetch(fetch));
});

it.effect("files paginates until a short page", () => {
  let maxPageSeen = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe("/repos/acme/widget/pulls/42/files");
    expect(url.searchParams.get("per_page")).toBe("100");
    const page = Number(url.searchParams.get("page") ?? "1");
    maxPageSeen = Math.max(maxPageSeen, page);
    if (page < 3) {
      return Response.json(
        Array.from({ length: 100 }, (_, i) => ({
          filename: `f-${page}-${i}.ts`,
          status: "modified",
        })),
      );
    }
    expect(page).toBe(3);
    return Response.json([{ filename: "last.ts", status: "added" }]);
  };

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const files = yield* github.files(pullRef);
    expect(files.length).toBe(201);
    expect(files[0]?.filename).toBe("f-1-0.ts");
    expect(files.at(-1)?.filename).toBe("last.ts");
    expect(maxPageSeen).toBe(3);
  }).pipe(withFetch(fetch));
});

it.effect("files does not request page 31 when every page is full", () => {
  let maxPageSeen = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const page = Number(url.searchParams.get("page") ?? "1");
    maxPageSeen = Math.max(maxPageSeen, page);
    expect(page).toBeLessThanOrEqual(30);
    return Response.json(
      Array.from({ length: 100 }, (_, i) => ({
        filename: `f-${page}-${i}.ts`,
        status: "modified",
      } satisfies ChangedFile)),
    );
  };

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const files = yield* github.files(pullRef);
    expect(files.length).toBe(3000);
    expect(maxPageSeen).toBe(30);
  }).pipe(withFetch(fetch));
});

it.effect("content returns none on 404 without failing", () => {
  const fetch: typeof globalThis.fetch = async () => new Response("missing", { status: 404 });

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const text = yield* github.content(repoRef, "src/missing.ts", "abc123");
    expect(Option.isNone(text)).toBe(true);
  }).pipe(withFetch(fetch));
});

it.effect("content returns text on success", () => {
  const fetch: typeof globalThis.fetch = async () => new Response("file body", { status: 200 });

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const text = yield* github.content(repoRef, "src/here.ts", "abc123");
    expect(Option.getOrThrow(text)).toBe("file body");
  }).pipe(withFetch(fetch));
});

it.effect("content maps non-404 failures to GitHubError with status", () => {
  const fetch: typeof globalThis.fetch = async () => new Response("nope", { status: 403 });

  return Effect.gen(function*() {
    const github = yield* GitHub;
    const error = yield* github.content(repoRef, "src/here.ts", "abc123").pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.operation).toBe("content");
    expect(error.status).toBe(403);
  }).pipe(withFetch(fetch));
});
