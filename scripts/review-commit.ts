/** Review one commit on a PR. Dry run by default; --post enables inline posting. */
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import config from "../reviewer.config.ts";
import * as GitHub from "../src/GitHub.ts";
import * as Pipeline from "../src/Pipeline.ts";
import * as Settings from "../src/Settings.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as LocalSql from "./LocalSql.ts";

const [target, baseSha, headSha, mode] = process.argv.slice(2);
const match = target?.match(/^([^/]+)\/([^#]+)#(\d+)$/);
const owner = match?.[1];
const repository = match?.[2];
const number = Number(match?.[3]);
if (!owner || !repository || !Number.isSafeInteger(number) || number < 1 ||
    !baseSha || !headSha || !/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(headSha) ||
    (mode !== undefined && mode !== "--post")) {
  throw new Error("usage: node scripts/review-commit.ts owner/repo#123 base-sha head-sha [--post]");
}
const ref = { owner, repository, number };
const Comparison = Schema.Struct({
  total_commits: Schema.Number,
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
  files: Schema.Array(GitHub.ChangedFile),
});

const program = Effect.gen(function* () {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const opencodeApiKey = yield* Config.Redacted("OPENCODE_API_KEY");
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const comparison = yield* http.get(
    `https://api.github.com/repos/${owner}/${repository}/compare/${baseSha}...${headSha}`,
    { headers: { authorization: `Bearer ${Redacted.value(token)}`,
      accept: "application/vnd.github+json", "user-agent": "reviewer/0.1" } },
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Comparison)),
  );
  if (comparison.total_commits !== 1 || comparison.merge_base_commit.sha !== baseSha ||
      comparison.files.length >= 300) {
    return yield* Effect.fail(new Error("Expected one complete commit comparison"));
  }
  const github = yield* GitHub.make(token);
  const scoped = GitHub.GitHub.of({
    ...github,
    mergeBase: () => Effect.succeed(baseSha),
    files: () => Effect.succeed(comparison.files),
    createReview: Effect.fnUntraced(function* (pull, input) {
      if (input.commitId !== headSha || input.comments.length === 0) {
        return yield* new GitHub.GitHubError({ operation: "review-commit",
          message: "Refusing to post without inline findings on the expected commit" });
      }
      const review = { ...input,
        body: `${input.body}\n\nReviewer verification experiment. Only the delta from ` +
          `\`${baseSha.slice(0, 7)}\` to \`${headSha.slice(0, 7)}\` was reviewed, with repository ` +
          "source available. This commit deliberately plants a bug; it is left in place at the author's request.",
      };
      yield* fs.makeDirectory(".local", { recursive: true }).pipe(
        Effect.mapError((error) => new GitHub.GitHubError({ operation: "save-review", message: String(error) })));
      yield* fs.writeFileString(`.local/review-${headSha}.json`, JSON.stringify(review, null, 2)).pipe(
        Effect.mapError((error) => new GitHub.GitHubError({ operation: "save-review", message: String(error) })));
      console.log(JSON.stringify(review, null, 2));
      if (mode === "--post") yield* github.createReview(pull, review);
      else console.log("Dry run: no review posted. Pass --post to publish.");
    }),
  });
  const sql = LocalSql.make();
  Snapshot.migrate(sql);
  const result = yield* Pipeline.run({
    job: { ...ref, headSha, settings: Settings.resolve(config, { owner, repository }) },
    sql, opencodeApiKey,
  }).pipe(Effect.provide(Layer.succeed(GitHub.GitHub, scoped)));
  console.log("Result:", result);
});

NodeRuntime.runMain(program.pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeFileSystem.layer),
));
