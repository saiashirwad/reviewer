import { Review } from "@yielded/agent-pr-review";
import { Effect, Option, Ref } from "effect";

export interface Pricing {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface NormalizedUsage {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

interface Totals {
  readonly stopped: boolean;
  readonly modelCalls: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly spent: number;
  readonly reserved: number;
}

const MIN_OUTPUT_TOKENS = 256;

export const make = Effect.fn("budgetCore.make")(function*(options: {
  readonly pricing: Pricing;
  readonly limitMicrousd: number;
}) {
  const { pricing, limitMicrousd } = options;
  const totals = yield* Ref.make<Totals>({
    stopped: false,
    modelCalls: 0,
    input: 0,
    cached: 0,
    output: 0,
    spent: 0,
    reserved: 0,
  });

  const reserve = Effect.fn("budgetCore.reserve")(function*(
    inputEstimate: number,
    requestedOutputTokens: number,
  ) {
    return yield* Ref.modify(
      totals,
      (current): [Option.Option<{ maxOutputTokens: number; reservation: number; }>, Totals] => {
        if (current.stopped) return [Option.none(), current];
        const balance = limitMicrousd - current.spent - current.reserved;
        const affordable = Math.floor((balance - inputEstimate * pricing.input) / pricing.output);
        const maxOutputTokens = Math.min(requestedOutputTokens, affordable);
        if (maxOutputTokens < MIN_OUTPUT_TOKENS) {
          return [Option.none(), { ...current, stopped: true }];
        }
        const reservation = inputEstimate * pricing.input + maxOutputTokens * pricing.output;
        return [
          Option.some({ maxOutputTokens, reservation }),
          {
            ...current,
            modelCalls: current.modelCalls + 1,
            reserved: current.reserved + reservation,
          },
        ];
      },
    );
  });

  const settle = Effect.fn("budgetCore.settle")(function*(
    reservation: number,
    usage: NormalizedUsage | undefined,
  ) {
    yield* Ref.update(totals, (current) => {
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
  });

  const costControl: Review.ReviewCostControl = {
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
  };

  return { reserve, settle, costControl };
});
