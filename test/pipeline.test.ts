import { expect, it } from "@effect/vitest";
import { ReviewContextError } from "@yielded/agent-pr-review/review-repository";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { afterEach, vi } from "vitest";
import { GitHub } from "../src/GitHub.ts";
import * as Pipeline from "../src/Pipeline.ts";
import * as ReviewRuntime from "../src/ReviewRuntime.ts";
import * as Settings from "../src/Settings.ts";
import * as Snapshot from "../src/Snapshot.ts";
import type { Snapshot as SnapshotType } from "../src/snapshot/types.ts";
import * as LocalSql from "./support/LocalSql.ts";

vi.mock("../src/Snapshot.ts", () => ({ load: vi.fn() }));
vi.mock("../src/ReviewRuntime.ts", () => ({ runReview: vi.fn() }));

afterEach(() => vi.resetAllMocks());

const job = {
  owner: "acme",
  repository: "widget",
  number: 1,
  settings: { model: "chat-model", maxCostUsd: 0.5, exclude: [] },
};

const runWithConfig = (read: SnapshotType["read"]) => {
  vi.mocked(Snapshot.load).mockReturnValue(Effect.succeed({
    paths: () => Effect.succeed([]),
    read,
  }));
  vi.mocked(ReviewRuntime.runReview).mockReturnValue(
    Effect.succeed({ _tag: "Skipped", reason: "test review" }),
  );
  const github = GitHub.of({
    pull: () =>
      Effect.succeed({
        number: 1,
        title: "Change",
        body: null,
        state: "open",
        head: { sha: "head" },
        base: { sha: "base", ref: "main" },
      }),
    mergeBase: () => Effect.succeed("merge-base"),
    files: () => Effect.succeed([{ filename: "a.ts", status: "modified", patch: "+new" }]),
    reviewBodies: () => Effect.succeed([]),
    tarball: () => Effect.die("Snapshot.load owns tarball retrieval"),
    content: () => Effect.die("Snapshot.load owns content retrieval"),
    createReview: () => Effect.die("Skipped reviews must not publish"),
  });
  return Pipeline.run({ job, sql: LocalSql.make(), opencodeApiKey: Redacted.make("test-key") })
    .pipe(
      Effect.provideService(GitHub, github),
    );
};

it.effect("repo config is read at base and applies model, guidance, and budget overrides", () =>
  Effect.gen(function*() {
    yield* runWithConfig((revision, path) => {
      expect(revision).toBe("base");
      expect(path).toBe(Settings.REPO_FILE_PATH);
      return Effect.succeedSome(JSON.stringify({
        model: "repo-model",
        guidance: "Check boundaries",
        maxCostUsd: 0.25,
      }));
    });
    expect(ReviewRuntime.runReview).toHaveBeenCalledWith(expect.objectContaining({
      model: "repo-model",
      guidance: "Check boundaries",
      limitMicrousd: 250_000,
    }));
  }));

it.effect("disabled repo config stops before the model review", () =>
  Effect.gen(function*() {
    const result = yield* runWithConfig(() => Effect.succeedSome('{"enabled":false}'));
    expect(result).toEqual({ _tag: "Skipped", reason: `disabled by ${Settings.REPO_FILE_PATH}` });
    expect(ReviewRuntime.runReview).not.toHaveBeenCalled();
  }));

it.effect("missing and unreadable repo configs retain job settings", () =>
  Effect.gen(function*() {
    const reads: ReadonlyArray<SnapshotType["read"]> = [
      () => Effect.succeed(Option.none()),
      () => Effect.fail(new ReviewContextError({ message: "unreadable config" })),
    ];
    for (const read of reads) {
      yield* runWithConfig(read);
      expect(ReviewRuntime.runReview).toHaveBeenLastCalledWith(expect.objectContaining({
        model: "chat-model",
        limitMicrousd: 500_000,
      }));
    }
  }));

it.effect("malformed JSON and invalid repo settings retain job settings", () =>
  Effect.gen(function*() {
    for (const text of ["not json", '{"maxCostUsd":0}', '{"model":""}']) {
      yield* runWithConfig(() => Effect.succeedSome(text));
      expect(ReviewRuntime.runReview).toHaveBeenLastCalledWith(expect.objectContaining({
        model: "chat-model",
        limitMicrousd: 500_000,
      }));
    }
  }));

it.effect("repo config defects are not treated as missing config", () =>
  Effect.gen(function*() {
    const exit = yield* runWithConfig(() => Effect.die("config defect")).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(ReviewRuntime.runReview).not.toHaveBeenCalled();
  }));
