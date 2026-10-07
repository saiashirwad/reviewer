import { Review } from "@yielded/agent-pr-review";
import { Effect, Ref } from "effect";

export interface Pricing {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface Totals {
  readonly stopped: boolean;
  readonly modelCalls: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly spent: number;
  readonly reserved: number;
}

export const emptyTotals = (): Totals => ({
  stopped: false,
  modelCalls: 0,
  input: 0,
  cached: 0,
  output: 0,
  spent: 0,
  reserved: 0,
});

export const settle = (
  totals: Ref.Ref<Totals>,
  pricing: Pricing,
  reservation: number,
  usage: { input: number; cached: number; output: number; } | undefined,
) =>
  Ref.update(totals, (current) => {
    if (usage === undefined) {
      return {
        ...current,
        reserved: current.reserved - reservation,
        spent: current.spent + reservation,
      };
    }
    const cost = (usage.input - usage.cached) * pricing.input
      + usage.cached * pricing.cached
      + usage.output * pricing.output;
    return {
      ...current,
      reserved: current.reserved - reservation,
      spent: current.spent + cost,
      input: current.input + usage.input,
      cached: current.cached + usage.cached,
      output: current.output + usage.output,
    };
  });

export const costControl = (totals: Ref.Ref<Totals>): Review.ReviewCostControl => ({
  snapshot: Ref.get(totals).pipe(
    Effect.map((current) =>
      Review.ReviewCostSnapshot.make({
        stopped: current.stopped,
        modelCalls: current.modelCalls,
        usage: Review.ReviewUsage.make({
          inputTokens: current.input,
          uncachedInputTokens: current.input - current.cached,
          cachedInputTokens: current.cached,
          cacheWriteInputTokens: 0,
          outputTokens: current.output,
          estimatedCostMicrousd: Math.ceil(current.spent),
          reservedCostMicrousd: Math.max(0, Math.ceil(current.reserved)),
        }),
      })
    ),
  ),
});
