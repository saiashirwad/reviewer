import type * as cf from "@cloudflare/workers-types";
import { ReviewContextError } from "@yielded/agent-pr-review/review-repository";
import { Effect, Option, Stream } from "effect";
import type { RepositoryRef } from "../domain.ts";
import { type ChangedFile, GitHub } from "../GitHub.ts";
import * as Tarball from "../Tarball.ts";
import { MAX_FILE_BYTES, type Revision, type Snapshot } from "./types.ts";

/**
 * Requires `GitHub` in context — provided around `Pipeline.run` from the DO callback.
 *
 * The head revision is copied from GitHub's tarball into SQLite. The base revision
 * matches head except on changed paths, whose base content is fetched lazily.
 */
export const migrate = (sql: cf.SqlStorage) => {
  sql.exec("CREATE TABLE IF NOT EXISTS snapshot_head (path TEXT PRIMARY KEY, content TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS snapshot_base (path TEXT PRIMARY KEY, content TEXT)");
  sql.exec("CREATE TABLE IF NOT EXISTS snapshot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
};

export const clear = (sql: cf.SqlStorage) => {
  sql.exec("DELETE FROM snapshot_head");
  sql.exec("DELETE FROM snapshot_base");
  sql.exec("DELETE FROM snapshot_meta");
};

const meta = (sql: cf.SqlStorage, key: string) =>
  sql.exec<{ value: string; }>("SELECT value FROM snapshot_meta WHERE key = ?", key).toArray()[0]
    ?.value;

const setMeta = (sql: cf.SqlStorage, key: string, value: string) =>
  sql.exec("INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)", key, value);

const copyHead = Effect.fn("Snapshot.copyHead")(function*(
  sql: cf.SqlStorage,
  repo: RepositoryRef,
  headSha: string,
) {
  if (meta(sql, "head") === headSha) return;

  clear(sql);
  const github = yield* GitHub;
  const tarball = yield* github.tarball(repo, headSha);
  const insert = (path: string, content: string | null) =>
    sql.exec("INSERT OR REPLACE INTO snapshot_head (path, content) VALUES (?, ?)", path, content);

  let files = 0;
  yield* Stream.fromAsyncIterable(
    Tarball.entries(tarball, { maxFileBytes: MAX_FILE_BYTES }),
    (cause) => ReviewContextError.make({ message: `Could not read the tarball: ${String(cause)}` }),
  ).pipe(
    Stream.runForEach((entry) =>
      Effect.sync(() => {
        files += 1;
        insert(entry.path, "text" in entry ? entry.text : null);
      })
    ),
  );

  setMeta(sql, "head", headSha);
  yield* Effect.logInfo("Copied head snapshot", { headSha, files });
});

type BaseOverride = "absent" | "fetch";

const baseOverrides = (files: ReadonlyArray<ChangedFile>) => {
  const overrides = new Map<string, BaseOverride>();
  for (const file of files) {
    if (file.status === "added" || file.status === "copied") {
      overrides.set(file.filename, "absent");
    } else if (file.status === "renamed") {
      overrides.set(file.filename, "absent");
      if (file.previous_filename) overrides.set(file.previous_filename, "fetch");
    } else {
      overrides.set(file.filename, "fetch");
    }
  }
  return overrides;
};

const unreadable = (path: string, revision: Revision) =>
  ReviewContextError.make({
    message: `${path} at ${revision} is binary or larger than ${
      MAX_FILE_BYTES / 1024
    } KiB and cannot be read.`,
  });

export const load = Effect.fn("Snapshot.load")(function*(options: {
  readonly sql: cf.SqlStorage;
  readonly repo: RepositoryRef;
  readonly headSha: string;
  readonly mergeBase: string;
  readonly files: ReadonlyArray<ChangedFile>;
}) {
  const { sql, repo, headSha, mergeBase } = options;
  yield* copyHead(sql, repo, headSha);

  const github = yield* GitHub;
  const overrides = baseOverrides(options.files);

  const headPaths = sql
    .exec<{ path: string; }>("SELECT path FROM snapshot_head ORDER BY path")
    .toArray()
    .map(({ path }) => path);

  const basePaths = (() => {
    const paths = new Set(headPaths);
    for (const [path, override] of overrides) {
      if (override === "absent") paths.delete(path);
      else paths.add(path);
    }
    return [...paths].sort();
  })();

  const readHead = (path: string): Option.Option<string | null> => {
    const row = sql
      .exec<{ content: string | null; }>("SELECT content FROM snapshot_head WHERE path = ?", path)
      .toArray()[0];
    return row === undefined ? Option.none() : Option.some(row.content);
  };

  const readBase = Effect.fnUntraced(function*(path: string) {
    const cached = sql
      .exec<{ content: string | null; }>("SELECT content FROM snapshot_base WHERE path = ?", path)
      .toArray()[0];
    if (cached !== undefined) return Option.some(cached.content);

    const fetched = yield* github.content(repo, path, mergeBase).pipe(
      Effect.mapError((error) =>
        ReviewContextError.make({ message: `Could not fetch ${path} at base: ${error.message}` })
      ),
    );
    if (Option.isNone(fetched)) return Option.none<string | null>();

    const text = fetched.value;
    const content = text.length > MAX_FILE_BYTES || text.includes("\0") ? null : text;
    sql.exec("INSERT OR REPLACE INTO snapshot_base (path, content) VALUES (?, ?)", path, content);
    return Option.some(content);
  });

  const toResult = (path: string, revision: Revision) => (row: Option.Option<string | null>) =>
    Option.isNone(row)
      ? Effect.succeedNone
      : row.value === null
      ? Effect.fail(unreadable(path, revision))
      : Effect.succeedSome(row.value);

  const snapshot: Snapshot = {
    paths: (revision) => Effect.succeed(revision === "head" ? headPaths : basePaths),
    read: (revision, path) => {
      if (revision === "head") return toResult(path, revision)(readHead(path));
      const override = overrides.get(path);
      if (override === "absent") return Effect.succeedNone;
      if (override === undefined) return toResult(path, revision)(readHead(path));
      return readBase(path).pipe(Effect.flatMap(toResult(path, revision)));
    },
  };

  return snapshot;
});
