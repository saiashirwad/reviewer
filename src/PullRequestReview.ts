import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";
import { GITHUB_TOKEN, OPENCODE_API_KEY } from "./config/bindings.ts";
import type { Job } from "./domain.ts";
import * as GitHub from "./GitHub.ts";
import * as Pipeline from "./Pipeline.ts";
import * as Snapshot from "./Snapshot.ts";

/** Failed deliveries retry a minute apart; after this many attempts a head is given up on. */
const MAX_ATTEMPTS = 3;

const JOB_ID = "pull-request";

export const key = (ref: GitHub.PullRef) => `${ref.owner}/${ref.repository}#${ref.number}`;

/**
 * One instance per pull request. Webhooks only enqueue; the review itself runs in
 * a durable callback, so it survives eviction and retries after a crash. A newer
 * push replaces a pending job, and the pipeline skips heads that have moved on.
 */
export class PullRequestReview extends Cloudflare.DurableObject<PullRequestReview>()(
  "PullRequestReview",
  Effect.gen(function*() {
    const state = yield* Cloudflare.DurableObjectState;
    // A missing secret is a deployment error, not something a review can recover from.
    // Same keys as Worker init — both orDie so Alchemy binds secrets on the script and DO.
    const githubToken = yield* Config.Redacted(GITHUB_TOKEN).pipe(Effect.orDie);
    const opencodeApiKey = yield* Config.Redacted(OPENCODE_API_KEY).pipe(Effect.orDie);

    return Effect.gen(function*() {
      const sql = state.storage.sql.raw;
      Snapshot.migrate(sql);

      const review = yield* Alchemy.makeCallback(
        "review",
        Effect.fnUntraced(function*(job: Job) {
          const attemptKey = `attempts:${job.headSha ?? "current"}`;
          const attempts = ((yield* state.storage.get<number>(attemptKey)) ?? 0) + 1;
          yield* state.storage.put(attemptKey, attempts);

          if (attempts > MAX_ATTEMPTS) {
            return yield* Effect.logError("Giving up on review", { pull: key(job), attempts });
          }

          const result = yield* Pipeline.run({ job, sql, opencodeApiKey }).pipe(
            Effect.provide(GitHub.layer(githubToken)),
            Effect.tapError((error) =>
              Effect.logError("Review failed", { pull: key(job), attempts, error: String(error) })
            ),
          );

          yield* state.storage.delete(attemptKey);
          yield* Effect.logInfo("Review finished", { pull: key(job), ...result });
        }),
        { retry: { delay: "1 minute" } },
      );

      return {
        enqueue: (job: Pipeline.Job) => review.schedule(JOB_ID, { after: 0, payload: job }),
        // Drops the copied source but keeps the scheduler's own tables intact.
        close: () =>
          Effect.gen(function*() {
            yield* review.cancel(JOB_ID);
            Snapshot.clear(sql);
            const attempts = yield* state.storage.list({ prefix: "attempts:" });
            yield* state.storage.delete([...attempts.keys()]);
          }),
      };
    });
  }),
) {}
