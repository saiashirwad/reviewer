import type * as cf from "@cloudflare/workers-types";
import { Review } from "@yielded/agent-pr-review";
import { OpenAiClient } from "@effect/ai-openai-compat";
import { Effect, Layer, Option, type Redacted, Result as Outcome, Schema } from "effect";
import { type ChangedFile, GitHub, type PullRef } from "./GitHub.ts";
import * as Model from "./Model.ts";
import * as Publish from "./Publish.ts";
import * as Repository from "./Repository.ts";
import * as Settings from "./Settings.ts";
import * as Snapshot from "./Snapshot.ts";
import * as Spending from "./Spending.ts";
import * as Responses from "./Responses.ts";

export interface Job extends PullRef {
  /** The head the webhook saw. Omitted for manual `/review` requests, which take the current head. */
  readonly headSha?: string;
  readonly settings: Settings.Settings;
}

export type Result =
  | { readonly _tag: "Published"; readonly headSha: string; readonly findings: number }
  | { readonly _tag: "Skipped"; readonly reason: string };

const skipped = (reason: string): Result => ({ _tag: "Skipped", reason });

const MAX_UNREVIEWED_PATHS = 300;

/**
 * The reviewer defaults to a 48k-token working context. Each rollover discards
 * unread tool results and forces rereads, and OpenCode Go's models have far
 * larger windows with cheap cached input, so use the reviewer's maximum.
 */
const CONTEXT_TOKEN_LIMIT = 128_000;

/** Split changed files into reviewable patches and disclosed exclusions within the reviewer's bounds. */
const admit = (files: ReadonlyArray<ChangedFile>, exclude: (path: string) => boolean) => {
  const changes: Array<Review.ReviewChange> = [];
  const unreviewed: Array<string> = [];
  let total = 0;

  for (const file of files) {
    const patch = file.patch;
    const fits =
      patch !== undefined &&
      patch.length > 0 &&
      patch.length <= Review.MAX_REVIEW_PATCH_CHARS &&
      total + patch.length <= Review.MAX_REVIEW_TOTAL_PATCH_CHARS &&
      changes.length < Review.MAX_REVIEW_FILES;

    if (fits && !exclude(file.filename)) {
      changes.push(Review.ReviewChange.make({ path: file.filename, patch }));
      total += patch.length;
    } else {
      unreviewed.push(file.filename);
    }
  }

  return { changes, unreviewed: unreviewed.slice(0, MAX_UNREVIEWED_PATHS) };
};

const readRepoFile = Effect.fnUntraced(function* (snapshot: Repository.Snapshot) {
  const text = yield* snapshot.read("base", Settings.REPO_FILE_PATH).pipe(Effect.option);
  if (Option.isNone(text) || Option.isNone(text.value)) return Option.none<Settings.RepoFile>();
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Settings.RepoFile))(
    text.value.value,
  ).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning(`Ignoring invalid ${Settings.REPO_FILE_PATH}`, { error: String(error) }).pipe(
        Effect.as(Option.none<Settings.RepoFile>()),
      ),
    ),
  );
});

export const run = Effect.fnUntraced(function* (options: {
  readonly job: Job;
  readonly sql: cf.SqlStorage;
  readonly opencodeApiKey: Redacted.Redacted<string>;
}) {
  const { job, sql } = options;
  const github = yield* GitHub;
  const pull = yield* github.pull(job);

  if (pull.state !== "open") return skipped("pull request is not open");
  if (pull.draft === true) return skipped("pull request is a draft");
  if (job.headSha !== undefined && job.headSha !== pull.head.sha) {
    return skipped(`head moved from ${job.headSha} to ${pull.head.sha}`);
  }

  const headSha = pull.head.sha;
  const existing = yield* github.reviewBodies(job);
  if (existing.some((body) => body.includes(Publish.marker(headSha)))) {
    return skipped(`${headSha} already has a review`);
  }

  const [mergeBase, files] = yield* Effect.all(
    [github.mergeBase(job, pull.base.sha, headSha), github.files(job)],
    { concurrency: 2 },
  );

  const snapshot = yield* Snapshot.load({ sql, repo: job, headSha, mergeBase, files });
  const repoFile = yield* readRepoFile(snapshot);
  if (Option.isSome(repoFile) && repoFile.value.enabled === false) {
    return skipped(`disabled by ${Settings.REPO_FILE_PATH}`);
  }

  const settings = Option.match(repoFile, {
    onNone: () => job.settings,
    onSome: (file) => Settings.applyRepoFile(job.settings, file),
  });
  const { changes, unreviewed } = admit(files, Settings.matcher(settings.exclude));
  if (changes.length === 0) return skipped("no reviewable changes");

  const request = Review.ReviewRequest.make({
    title: pull.title.slice(0, 1_000),
    description: (pull.body ?? "").slice(0, 20_000),
    baseRevision: mergeBase,
    headRevision: headSha,
    changes,
    unreviewedPaths: unreviewed,
  });

  yield* Effect.logInfo("Reviewing", {
    pull: `${job.owner}/${job.repository}#${job.number}`,
    headSha,
    model: settings.model,
    changes: changes.length,
    unreviewed: unreviewed.length,
  });

  const chatReview = Effect.gen(function* () {
  const spending = yield* Spending.make({
    model: settings.model,
    limitMicrousd: Math.round(settings.maxCostUsd * 1_000_000),
  }).pipe(
    Effect.provide(
      Model.OpenCodeGoClient({
        apiKey: options.opencodeApiKey,
        sessionId: `${job.owner}/${job.repository}#${job.number}@${headSha}`,
      }),
    ),
    Effect.result,
  );
  if (Outcome.isFailure(spending)) return skipped(spending.failure.message);

  const { review } = Review.makeReviewer({
    model: Model.model(settings.model),
    guidance: settings.guidance,
    contextTokenLimit: CONTEXT_TOKEN_LIMIT,
    costControl: spending.success.costControl,
  });
  const outcome = yield* review(request).pipe(
    Effect.provide(
      Layer.mergeAll(
        Repository.layer(snapshot),
        Layer.succeed(OpenAiClient.OpenAiClient, spending.success.client),
      ),
    ),
  );

  return outcome;
  });

  const outcome = yield* (settings.model === Responses.MUSE_MODEL
    ? Responses.review({
        request,
        apiKey: options.opencodeApiKey,
        sessionId: `${job.owner}/${job.repository}#${job.number}@${headSha}`,
        limitMicrousd: Math.round(settings.maxCostUsd * 1_000_000),
        guidance: settings.guidance,
      }).pipe(Effect.provide(Repository.layer(snapshot)))
    : chatReview);
  if (!("report" in outcome)) return outcome;

  // The model may have taken minutes; don't publish against a head that has moved on.
  const latest = yield* github.pull(job);
  if (latest.head.sha !== headSha) return skipped(`head moved to ${latest.head.sha} during review`);

  const rendered = Publish.render({
    outcome,
    model: settings.model,
    headSha,
    unreviewedPaths: unreviewed,
  });
  yield* github
    .createReview(job, { commitId: headSha, body: rendered.body, comments: rendered.comments })
    .pipe(
      Effect.catchIf(
        (error) => error.status === 422 && rendered.comments.length > 0,
        (error) =>
          Effect.logWarning("GitHub rejected inline comments; posting findings in the body", {
            message: error.message,
          }).pipe(
            Effect.andThen(
              github.createReview(job, { commitId: headSha, body: rendered.bodyOnly, comments: [] }),
            ),
          ),
      ),
    );

  return {
    _tag: "Published",
    headSha,
    findings: outcome.report.findings.length,
  } satisfies Result as Result;
});
