import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHub, GitHubError } from "../src/GitHub.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as LocalSql from "./support/LocalSql.ts";

const head = {
  "src/kept.ts": "export const kept = 1;\n",
  "src/changed.ts": "export const changed = 2;\n",
  "src/added.ts": "export const added = 3;\n",
  "src/renamed-new.ts": "export const renamed = 4;\n",
};

const base: Record<string, string> = {
  "src/changed.ts": "export const changed = 1;\n",
  "src/removed.ts": "export const removed = 0;\n",
  "src/renamed-old.ts": "export const renamed = 4;\n",
};

const tarball = () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-snapshot-"));
  for (const [path, content] of Object.entries(head)) {
    const target = join(dir, "root", path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const archive = join(dir, "repo.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "root"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return new Blob([readFileSync(archive)]).stream();
};

const fakeGitHub = (calls: { tarball: number; content: Array<string>; }) =>
  Layer.succeed(
    GitHub,
    GitHub.of({
      tarball: () => Effect.sync(() => (calls.tarball++, tarball())),
      content: (_repo, path) =>
        Effect.sync(() => (calls.content.push(path), Option.fromNullishOr(base[path]))),
      pull: () => Effect.fail(new GitHubError({ operation: "pull", message: "unused" })),
      mergeBase: () => Effect.fail(new GitHubError({ operation: "mergeBase", message: "unused" })),
      files: () => Effect.fail(new GitHubError({ operation: "files", message: "unused" })),
      reviewBodies: () => Effect.succeed([]),
      createReview: () => Effect.void,
    }),
  );

const files = [
  { filename: "src/changed.ts", status: "modified" },
  { filename: "src/added.ts", status: "added" },
  { filename: "src/removed.ts", status: "removed" },
  { filename: "src/renamed-new.ts", status: "renamed", previous_filename: "src/renamed-old.ts" },
];

it.effect("base is head with changed paths overlaid, fetched lazily and cached", () => {
  const sql = LocalSql.make();
  Snapshot.migrate(sql);
  const calls = { tarball: 0, content: [] as Array<string> };

  return Effect.gen(function*() {
    const load = () =>
      Snapshot.load({
        sql,
        repo: { owner: "o", repository: "r" },
        headSha: "head1",
        mergeBase: "base1",
        files,
      });
    const snapshot = yield* load();

    expect(yield* snapshot.paths("head")).toEqual([
      "src/added.ts",
      "src/changed.ts",
      "src/kept.ts",
      "src/renamed-new.ts",
    ]);
    expect(yield* snapshot.paths("base")).toEqual([
      "src/changed.ts",
      "src/kept.ts",
      "src/removed.ts",
      "src/renamed-old.ts",
    ]);

    const read = (revision: "base" | "head", path: string) =>
      snapshot.read(revision, path).pipe(Effect.map(Option.getOrUndefined));

    expect(yield* read("head", "src/changed.ts")).toBe("export const changed = 2;\n");
    expect(yield* read("base", "src/changed.ts")).toBe("export const changed = 1;\n");
    expect(yield* read("base", "src/kept.ts")).toBe("export const kept = 1;\n");
    expect(yield* read("base", "src/added.ts")).toBeUndefined();
    expect(yield* read("base", "src/removed.ts")).toBe("export const removed = 0;\n");
    expect(yield* read("head", "src/removed.ts")).toBeUndefined();
    expect(yield* read("base", "src/renamed-old.ts")).toBe("export const renamed = 4;\n");

    yield* read("base", "src/changed.ts");
    yield* load();
    expect(calls.tarball).toBe(1);
    expect(calls.content.sort()).toEqual([
      "src/changed.ts",
      "src/removed.ts",
      "src/renamed-old.ts",
    ]);
  }).pipe(Effect.provide(fakeGitHub(calls)));
});
