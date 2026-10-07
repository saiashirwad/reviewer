import { Effect, Schema } from "effect";
import * as Management from "../src/Management.ts";
import { CliError } from "./management/Runtime.ts";

const GitSha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

const ReviewCommitArgv = Schema.Tuple([
  Schema.String,
  GitSha,
  GitSha,
  Schema.optionalKey(Schema.Literal("--post")),
]);

const DryRunArgv = Schema.Tuple([
  Schema.String,
  Schema.optionalKey(Schema.String),
]);

export const reviewCommitUsage =
  "usage: node scripts/review-commit.ts <owner/repo#123 | GitHub PR URL> base-sha head-sha [--post]";

export const dryRunUsage =
  "usage: pnpm review <owner/repo#123 | GitHub PR URL> [model] (never posts)";

export const decodeReviewCommitArgv = Effect.fn("ReviewArgs.decodeReviewCommitArgv")(function*(
  argv: ReadonlyArray<string>,
) {
  const decoded = yield* Schema.decodeUnknownEffect(ReviewCommitArgv)(argv).pipe(
    Effect.mapError(() => new CliError({ message: reviewCommitUsage })),
  );
  const [target, baseSha, headSha, postFlag] = decoded;
  const ref = yield* Management.parsePull(target).pipe(
    Effect.mapError(() => new CliError({ message: reviewCommitUsage })),
  );
  return { ref, baseSha, headSha, post: postFlag === "--post" };
});

export const decodeDryRunArgv = Effect.fn("ReviewArgs.decodeDryRunArgv")(function*(
  argv: ReadonlyArray<string>,
) {
  const [target, modelOverride] = yield* Schema.decodeUnknownEffect(DryRunArgv)(argv).pipe(
    Effect.mapError(() => new CliError({ message: dryRunUsage })),
  );
  return modelOverride === undefined ? { target } : { target, modelOverride };
});
