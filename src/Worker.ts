import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHubEvents from "alchemy/GitHub";
import { Config, Effect, type Redacted } from "effect";
import { HttpServerResponse } from "effect/http";
import config from "../reviewer.config.ts";
import type { PullRef } from "./GitHub.ts";
import { key, PullRequestReview } from "./PullRequestReview.ts";
import * as Settings from "./Settings.ts";

const REVIEW_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
const TRUSTED_COMMENTERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export default Cloudflare.Worker(
  "Reviewer",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Read during init so Alchemy binds both secrets onto the Worker; the
    // Durable Object reads the same bindings at runtime.
    yield* Config.Redacted("GITHUB_TOKEN").pipe(Effect.orDie);
    yield* Config.Redacted("OPENCODE_API_KEY").pipe(Effect.orDie);

    const reviews = yield* PullRequestReview;
    // Generated once and kept in Alchemy state. The event source resolves Outputs
    // (it calls Output.asOutput on the secret), but its prop is typed as a plain Redacted.
    const secret = (yield* Alchemy.makeRandom("WebhookSecret")) as unknown as Redacted.Redacted<string>;

    for (const entry of config.repos) {
      const settings = Settings.resolve(config, entry);
      const pull = (number: number): PullRef => ({
        owner: entry.owner,
        repository: entry.repository,
        number,
      });

      yield* GitHubEvents.consumeRepositoryEvents(
        {
          owner: entry.owner,
          repository: entry.repository,
          events: ["pull_request", "issue_comment"],
          secret,
        },
        (event) => {
          const dispatch = Effect.gen(function* () {
            switch (event.name) {
              case "pull_request": {
                const { action, pull_request } = event.payload;
                const ref = pull(pull_request.number);
                if (action === "closed") {
                  return yield* reviews.getByName(key(ref)).close();
                }
                if (REVIEW_ACTIONS.has(action) && !pull_request.draft) {
                  return yield* reviews
                    .getByName(key(ref))
                    .enqueue({ ...ref, headSha: pull_request.head.sha, settings });
                }
                return;
              }
              case "issue_comment": {
                const { action, comment, issue } = event.payload;
                const requested =
                  action === "created" &&
                  issue.pull_request !== undefined &&
                  comment.body.trim().startsWith("/review") &&
                  TRUSTED_COMMENTERS.has(comment.author_association);
                if (!requested) return;
                const ref = pull(issue.number);
                return yield* reviews.getByName(key(ref)).enqueue({ ...ref, settings });
              }
            }
          });

          return dispatch.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Could not dispatch webhook", { delivery: event.id, cause }),
            ),
          );
        },
      );
    }

    return {
      fetch: Effect.succeed(HttpServerResponse.text("reviewer")),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive)),
);
