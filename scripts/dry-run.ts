/**
 * Runs the full pipeline against a real pull request without posting anything:
 * the tarball, merge base, patches, and model calls are real; the review is printed.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/dry-run.ts owner/repo#123 [model]
 */
import { NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import config from "../reviewer.config.ts";
import * as GitHub from "../src/GitHub.ts";
import * as Pipeline from "../src/Pipeline.ts";
import * as Settings from "../src/Settings.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as LocalSql from "./LocalSql.ts";

const [target, modelOverride] = process.argv.slice(2);
const match = target?.match(/^([^/]+)\/([^#]+)#(\d+)$/);
if (!match) {
  console.error("usage: node scripts/dry-run.ts owner/repo#123 [model]");
  process.exit(1);
}
const [, owner, repository, number] = match as unknown as [string, string, string, string];

const printReviews = Layer.effect(
  GitHub.GitHub,
  Effect.gen(function* () {
    const github = yield* GitHub.GitHub;
    return GitHub.GitHub.of({
      ...github,
      createReview: (_ref, input) =>
        Effect.sync(() => {
          console.log(`\n${"=".repeat(80)}\nReview for ${input.commitId}\n${"=".repeat(80)}`);
          console.log(input.body);
          for (const comment of input.comments) {
            console.log(`\n--- ${comment.path}:${comment.line}\n${comment.body}`);
          }
        }),
    });
  }),
);

const program = Effect.gen(function* () {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const opencodeApiKey = yield* Config.Redacted("OPENCODE_API_KEY");
  const sql = LocalSql.make();
  Snapshot.migrate(sql);

  const entry = { owner, repository, ...(modelOverride ? { model: modelOverride } : {}) };
  const result = yield* Pipeline.run({
    job: { owner, repository, number: Number(number), settings: Settings.resolve(config, entry) },
    sql,
    opencodeApiKey,
  }).pipe(Effect.provide(printReviews.pipe(Layer.provide(GitHub.layer(token)))));

  console.log("\nResult:", result);
});

NodeRuntime.runMain(program.pipe(Effect.provide(FetchHttpClient.layer)));
