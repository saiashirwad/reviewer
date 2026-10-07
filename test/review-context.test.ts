import { expect, it } from "@effect/vitest";
import { ReviewContextError } from "@yielded/agent-pr-review/review-repository";
import { Cause, Effect, Exit, Option } from "effect";
import * as ReviewContext from "../src/ReviewContext.ts";
import { fromMaps, type Snapshot } from "../src/snapshot/types.ts";

it.effect("direct reads preserve line ranges and reject missing or unreadable source", () =>
  Effect.gen(function*() {
    const failure = new ReviewContextError({ message: "binary source" });
    const snapshot: Snapshot = {
      paths: () => Effect.succeed([]),
      read: (_revision, path) =>
        path === "readable.ts"
          ? Effect.succeedSome("first\nsecond\nthird\n")
          : path === "binary.ts"
          ? Effect.fail(failure)
          : Effect.succeedNone,
    };
    const repository = ReviewContext.make(snapshot);
    const range = { revision: "head" as const, startLine: 2, lineCount: 1 };
    expect(yield* repository.readFile({ ...range, path: "readable.ts" })).toMatchObject({
      content: "second",
      totalLines: 3,
      startLine: 2,
    });
    expect(yield* repository.readFile({ ...range, path: "binary.ts" }).pipe(Effect.flip))
      .toBe(failure);
    expect(yield* repository.readFile({ ...range, path: "missing.ts" }).pipe(Effect.flip))
      .toMatchObject({ message: "missing.ts does not exist at head." });
  }));

it.effect("search records missing and unreadable paths without hiding path-list failures", () =>
  Effect.gen(function*() {
    const failure = new ReviewContextError({ message: "source unavailable" });
    const snapshot: Snapshot = {
      paths: () => Effect.succeed(["binary.ts", "missing.ts", "readable.ts"]),
      read: (_revision, path) =>
        path === "binary.ts"
          ? Effect.fail(failure)
          : Effect.succeed(path === "missing.ts" ? Option.none() : Option.some("needle")),
    };
    const input = { query: "needle", path: "", revision: "base" as const, cursor: 0 };
    expect(yield* ReviewContext.make(snapshot).searchCode(input)).toMatchObject({
      unreadablePaths: ["binary.ts", "missing.ts"],
      matches: [{ path: "readable.ts", line: 1, content: "needle" }],
      truncated: false,
    });
    const unavailable = ReviewContext.make({
      ...snapshot,
      paths: () => Effect.fail(failure),
    });
    expect(yield* unavailable.searchCode(input).pipe(Effect.flip)).toBe(failure);
    expect(yield* unavailable.findFiles({ query: "", revision: "base" }).pipe(Effect.flip))
      .toBe(failure);
  }));

it.effect("search paginates candidate files and bounds matching lines and content", () =>
  Effect.gen(function*() {
    const files = new Map(
      Array.from({ length: 21 }, (_, index) => [
        `src/${String(index).padStart(2, "0")}.ts`,
        index === 0 ? Array(6).fill(`needle${"x".repeat(600)}`).join("\n") : "needle",
      ]),
    );
    const repository = ReviewContext.make(fromMaps({ base: files, head: files }));
    const input = { query: "needle", path: "src/", revision: "head" as const, cursor: 0 };
    const first = yield* repository.searchCode(input);
    expect(first.matches).toHaveLength(24);
    expect(first.matches.slice(0, 5).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5]);
    expect(first.matches[0]?.content).toHaveLength(500);
    expect(first.nextCursor).toBe(20);
    expect(first.truncated).toBe(true);
    const last = yield* repository.searchCode({ ...input, cursor: 20 });
    expect(last.matches).toMatchObject([{ path: "src/20.ts", line: 1 }]);
    expect(last.nextCursor).toBeUndefined();
    expect(last.truncated).toBe(false);
  }));

it.effect("another search page alone does not mean matching lines were truncated", () =>
  Effect.gen(function*() {
    const files = new Map(Array.from({ length: 101 }, (_, index) => [`${index}.ts`, "needle"]));
    const repository = ReviewContext.make(fromMaps({ base: files, head: files }));
    const found = yield* repository.findFiles({ query: ".ts", revision: "head" });
    expect(found.paths).toHaveLength(100);
    expect(found.truncated).toBe(true);
    const searched = yield* repository.searchCode({
      query: "needle",
      path: "",
      revision: "head",
      cursor: 0,
    });
    expect(searched.nextCursor).toBe(20);
    expect(searched.truncated).toBe(false);
  }));

it.effect("search does not recover defects as unreadable files", () =>
  Effect.gen(function*() {
    const defect = new Error("snapshot defect");
    const repository = ReviewContext.make({
      paths: () => Effect.succeed(["broken.ts"]),
      read: () => Effect.die(defect),
    });
    const exit = yield* repository.searchCode({
      query: "needle",
      path: "",
      revision: "head",
      cursor: 0,
    }).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
  }));
