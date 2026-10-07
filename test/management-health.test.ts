import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { CliError, layer, Runtime } from "../scripts/management/Runtime.ts";

const withFetch = (fetch: typeof globalThis.fetch) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

it.effect("health returns false for unsuccessful HTTP status", () => {
  const fetch: typeof globalThis.fetch = async () => new Response("reviewer", { status: 503 });
  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    expect(yield* runtime.health("https://reviewer.example")).toBe(false);
  }).pipe(withFetch(fetch));
});

it.effect("health maps transport failures to the CLI error", () => {
  const fetch: typeof globalThis.fetch = async () => {
    throw new Error("network failure");
  };
  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    const error = yield* runtime.health("https://reviewer.example").pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(withFetch(fetch));
});

it.effect("health maps response body failures to the CLI error", () => {
  const fetch: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body failure"));
        },
      }),
    );
  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    const error = yield* runtime.health("https://reviewer.example").pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(withFetch(fetch));
});

it.effect("health bounds response wait time and aborts the request", () =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          Deferred.doneUnsafe(aborted, Effect.void);
          reject(new Error("aborted"));
        }, { once: true });
        Deferred.doneUnsafe(ready, Effect.void);
      });
    yield* Effect.gen(function*() {
      const runtime = yield* Runtime;
      const fiber = yield* runtime.health("https://reviewer.example").pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toEqual(
        new CliError({ message: "Command failed" }),
      );
      expect(yield* Deferred.isDone(aborted)).toBe(true);
    }).pipe(withFetch(fetch));
  }));

it.effect("health timeout also covers response body consumption", () =>
  Effect.gen(function*() {
    const reading = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull() {
            Deferred.doneUnsafe(reading, Effect.void);
          },
        }),
      );
    yield* Effect.gen(function*() {
      const runtime = yield* Runtime;
      const fiber = yield* runtime.health("https://reviewer.example").pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toEqual(
        new CliError({ message: "Command failed" }),
      );
    }).pipe(withFetch(fetch));
  }));

it.effect("interrupting health aborts an in-flight request without returning a CLI error", () =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          Deferred.doneUnsafe(aborted, Effect.void);
          reject(new Error("aborted"));
        }, { once: true });
        Deferred.doneUnsafe(ready, Effect.void);
      });
    yield* Effect.gen(function*() {
      const runtime = yield* Runtime;
      const fiber = yield* runtime.health("https://reviewer.example").pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(yield* Deferred.isDone(aborted)).toBe(true);
    }).pipe(withFetch(fetch));
  }));
