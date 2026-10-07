import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import * as budgetCore from "../src/budgetCore.ts";

const pricing = { input: 1, cached: 0.5, output: 2 };

it.effect("concurrent reservations admit exactly one call within the limit", () =>
  Effect.gen(function*() {
    const budget = yield* budgetCore.make({ pricing, limitMicrousd: 1000 });
    const first = yield* budget.reserve(100, 400).pipe(Effect.forkScoped);
    const second = yield* budget.reserve(100, 400).pipe(Effect.forkScoped);
    const reservations = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    const admitted = reservations.filter(Option.isSome);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.value.reservation).toBe(900);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.modelCalls).toBe(1);
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.usage.reservedCostMicrousd).toBe(900);
  }));

it.effect("settlement releases the reservation without undoing a previous refusal", () =>
  Effect.gen(function*() {
    const budget = yield* budgetCore.make({ pricing, limitMicrousd: 1000 });
    const admitted = yield* budget.reserve(100, 400);
    if (Option.isNone(admitted)) return yield* Effect.die("expected admission");
    expect(yield* budget.reserve(100, 400)).toEqual(Option.none());
    yield* budget.settle(admitted.value.reservation, { input: 10, cached: 0, output: 5 });
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(yield* budget.reserve(1, 256)).toEqual(Option.none());
  }));

it.effect("insufficient output allowance refuses without counting a model call", () =>
  Effect.gen(function*() {
    const budget = yield* budgetCore.make({ pricing, limitMicrousd: 300 });
    expect(yield* budget.reserve(200, 100)).toEqual(Option.none());
    expect(yield* budget.reserve(10, 256)).toEqual(Option.none());
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.modelCalls).toBe(0);
  }));

it.effect("settlement rounds fractional costs up in the review snapshot", () =>
  Effect.gen(function*() {
    const budget = yield* budgetCore.make({
      pricing: { input: 0.15, cached: 0.03, output: 0.5 },
      limitMicrousd: 10_000,
    });
    const admitted = yield* budget.reserve(10, 256);
    if (Option.isNone(admitted)) return yield* Effect.die("expected admission");
    yield* budget.settle(admitted.value.reservation, { input: 10, cached: 3, output: 5 });
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.estimatedCostMicrousd).toBe(4);
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.cachedInputTokens).toBe(3);
    expect(snapshot.usage.uncachedInputTokens).toBe(7);
    expect(snapshot.usage.outputTokens).toBe(5);
  }));

it.effect("settlement without usage charges the full reservation", () =>
  Effect.gen(function*() {
    const budget = yield* budgetCore.make({ pricing, limitMicrousd: 10_000 });
    const admitted = yield* budget.reserve(50, 300);
    if (Option.isNone(admitted)) return yield* Effect.die("expected admission");
    yield* budget.settle(admitted.value.reservation, undefined);
    const snapshot = yield* budget.costControl.snapshot;
    expect(snapshot.usage.reservedCostMicrousd).toBe(0);
    expect(snapshot.usage.estimatedCostMicrousd).toBe(650);
  }));
