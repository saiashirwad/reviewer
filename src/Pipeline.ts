import type * as cf from "@cloudflare/workers-types";
import { Review } from "@yielded/agent-pr-review";
import { Effect, Option, type Redacted, Schema } from "effect";
import { type Job, type Result, skipped } from "./domain.ts";
import { type ChangedFile, GitHub } from "./GitHub.ts";
import * as Publish from "./Publish.ts";
import * as ReviewRuntime from "./ReviewRuntime.ts";
import * as Settings from "./Settings.ts";
import * as Snapshot from "./Snapshot.ts";
import type { Snapshot as SnapshotType } from "./snapshot/types.ts";

export type { Job, Result } from "./domain.ts";

const MAX_UNREVIEWED_PATHS = 300;

const admit = (files: ReadonlyArray<ChangedFile>, exclude: (path: string) => boolean) => {
  const changes: Array<Review.ReviewChange> = [];
  const unreviewed: Array<string> = [];
  let total = 0;

  for (const file of files) {
    const patch = file.patch;
    const fits = patch !== undefined
      && patch.length > 0
      && patch.length <= Review.MAX_REVIEW_PATCH_CHARS
      && total + patch.length <= Review.MAX_REVIEW_TOTAL_PATCH_CHARS
      && changes.length < Review.MAX_REVIEW_FILES;

    if (fits && !exclude(file.filename)) {
      changes.push(Review.ReviewChange.make({ path: file.filename, patch }));
      total += patch.length;
    } else {
      unreviewed.push(file.filename);
    }
  }

  return { changes, unreviewed: unreviewed.slice(0, MAX_UNREVIEWED_PATHS) };
};

const readRepoFile = Effect.fn("Pipeline.readRepoFile")(function*(snapshot: SnapshotType) {
  const text = yield* snapshot.read("base", Settings.REPO_FILE_PATH).pipe(
    Effect.catchTag("ReviewContextError", () => Effect.succeedNone),
  );
  if (Option.isNone(text)) return Option.none<Settings.RepoFile>();
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Settings.RepoFile))(
    text.value,
  ).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning(`Ignoring invalid ${Settings.REPO_FILE_PATH}`, { error: String(error) })
        .pipe(
          Effect.as(Option.none<Settings.RepoFile>()),
        )
    ),
  );
});

export const run = Effect.fn("Pipeline.run")(function*(options: {
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

  const sessionId = `${job.owner}/${job.repository}#${job.number}@${headSha}`;
  const limitMicrousd = Math.round(settings.maxCostUsd * 1_000_000);

  const review = yield* ReviewRuntime.runReview({
    request,
    snapshot,
    apiKey: options.opencodeApiKey,
    sessionId,
    model: settings.model,
    limitMicrousd,
    guidance: settings.guidance,
  });

  if (review._tag !== "Completed") return review;

  const { outcome } = review;

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
              github.createReview(job, {
                commitId: headSha,
                body: rendered.bodyOnly,
                comments: [],
              }),
            ),
          ),
      ),
    );

  return {
    _tag: "Published",
    headSha,
    findings: outcome.report.findings.length,
  } satisfies Result;
});
