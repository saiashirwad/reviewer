import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import config from "../reviewer.config.ts";
import * as GitHub from "../src/GitHub.ts";
import * as Management from "../src/Management.ts";
import * as Pipeline from "../src/Pipeline.ts";
import * as Settings from "../src/Settings.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as LocalSql from "./LocalSql.ts";
import * as Runtime from "./management/Runtime.ts";
import * as ReviewArgs from "./ReviewArgs.ts";

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h") {
  console.log(ReviewArgs.dryRunUsage);
  process.exit(0);
}

const printReviews = Layer.effect(
  GitHub.GitHub,
  Effect.gen(function*() {
    const github = yield* GitHub.GitHub;
    return GitHub.GitHub.of({
      ...github,
      reviewBodies: () => Effect.succeed([]),
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

const runReview = Effect.fn("dryRun.runReview")(function*(
  args: { readonly target: string; readonly modelOverride?: string; },
) {
  const ref = yield* Management.parsePull(args.target);
  const configured = config.repos.find((entry) => Management.repoIdentityEquals(entry, ref));
  const entry = {
    ...(configured ?? ref),
    ...(args.modelOverride ? { model: args.modelOverride } : {}),
  };
  const token = yield* Runtime.githubToken;
  const opencodeApiKey = yield* Runtime.opencodeKey;
  const sql = LocalSql.make();
  Snapshot.migrate(sql);

  const result = yield* Pipeline.run({
    job: { ...ref, settings: Settings.resolve(config, entry) },
    sql,
    opencodeApiKey,
  }).pipe(Effect.provide(printReviews.pipe(Layer.provide(GitHub.layer(token)))));

  console.log("\nResult:", result);
});

NodeRuntime.runMain(
  Effect.gen(function*() {
    const args = yield* ReviewArgs.decodeDryRunArgv(argv);
    yield* Runtime.loadEnvironment();
    yield* runReview(args).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())));
  }).pipe(Effect.provide(Layer.mergeAll(Runtime.layer, FetchHttpClient.layer))),
);
