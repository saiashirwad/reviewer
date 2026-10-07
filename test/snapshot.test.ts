import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Layer, Option } from "effect";
import * as LocalSql from "./support/LocalSql.ts";
import { GitHub, GitHubError } from "../src/GitHub.ts";
import * as Snapshot from "../src/Snapshot.ts";

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
  execFileSync("tar", ["-czf", archive, "-C", dir, "root"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return new Blob([readFileSync(archive)]).stream();
};

const fakeGitHub = (calls: { tarball: number; content: Array<string> }) =>
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

test("base is head with changed paths overlaid, fetched lazily and cached", async () => {
  const sql = LocalSql.make();
  Snapshot.migrate(sql);
  const calls = { tarball: 0, content: [] as Array<string> };

  const program = Effect.gen(function* () {
    const load = () =>
      Snapshot.load({
        sql,
        repo: { owner: "o", repository: "r" },
        headSha: "head1",
        mergeBase: "base1",
        files,
      });
    const snapshot = yield* load();

    assert.deepEqual(yield* snapshot.paths("head"), [
      "src/added.ts",
      "src/changed.ts",
      "src/kept.ts",
      "src/renamed-new.ts",
    ]);
    assert.deepEqual(yield* snapshot.paths("base"), [
      "src/changed.ts",
      "src/kept.ts",
      "src/removed.ts",
      "src/renamed-old.ts",
    ]);

    const read = (revision: "base" | "head", path: string) =>
      snapshot.read(revision, path).pipe(Effect.map(Option.getOrUndefined));

    assert.equal(yield* read("head", "src/changed.ts"), head["src/changed.ts"]);
    assert.equal(yield* read("base", "src/changed.ts"), base["src/changed.ts"]);
    assert.equal(yield* read("base", "src/kept.ts"), head["src/kept.ts"]);
    assert.equal(yield* read("base", "src/added.ts"), undefined);
    assert.equal(yield* read("base", "src/removed.ts"), base["src/removed.ts"]);
    assert.equal(yield* read("head", "src/removed.ts"), undefined);
    assert.equal(yield* read("base", "src/renamed-old.ts"), base["src/renamed-old.ts"]);

    // Cached base reads and an unchanged head never hit GitHub again.
    yield* read("base", "src/changed.ts");
    yield* load();
  });

  await Effect.runPromise(program.pipe(Effect.provide(fakeGitHub(calls))));

  assert.equal(calls.tarball, 1);
  assert.deepEqual(calls.content.sort(), [
    "src/changed.ts",
    "src/removed.ts",
    "src/renamed-old.ts",
  ]);
});
