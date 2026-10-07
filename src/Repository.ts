import {
  ReviewContextError,
  ReviewFileList,
  ReviewRepository,
  ReviewSearchMatch,
  ReviewSearchResult,
  ReviewSource,
} from "@yielded/agent-pr-review/review-repository";
import { Effect, Layer, Option } from "effect";

export type Revision = "base" | "head";

/** Read-only access to the two revisions under review. Paths are sorted. */
export interface Snapshot {
  readonly paths: (revision: Revision) => Effect.Effect<ReadonlyArray<string>, ReviewContextError>;
  readonly read: (
    revision: Revision,
    path: string,
  ) => Effect.Effect<Option.Option<string>, ReviewContextError>;
}

// Bounds mirror the reviewer's tool contracts in @yielded/agent-pr-review.
const MAX_LISTED_PATHS = 100;
const SEARCH_FILES_PER_PAGE = 20;
const SEARCH_LINES_PER_FILE = 5;
const MAX_MATCH_CHARS = 500;
const MAX_UNREADABLE_PATHS = 20;

const missing = (path: string, revision: Revision) =>
  ReviewContextError.make({ message: `${path} does not exist at ${revision}.` });

export const make = (snapshot: Snapshot) =>
  ReviewRepository.of({
    readFile: (input) =>
      snapshot.read(input.revision, input.path).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(missing(input.path, input.revision)),
            onSome: (text) => ReviewSource.fromText(input, text),
          }),
        ),
        Effect.tapError((error) => Effect.logWarning("Source read failed", {
          path: input.path, revision: input.revision, message: error.message,
        })),

      ),

    findFiles: ({ query, revision }) =>
      snapshot.paths(revision).pipe(
        Effect.map((paths) => {
          const matches = paths.filter((path) => path.includes(query));
          return ReviewFileList.make({
            paths: matches.slice(0, MAX_LISTED_PATHS),
            truncated: matches.length > MAX_LISTED_PATHS,
          });
        }),
      ),

    searchCode: Effect.fnUntraced(function* ({ query, path, revision, cursor }) {
      const candidates = (yield* snapshot.paths(revision)).filter((p) => p.includes(path));
      const page = candidates.slice(cursor, cursor + SEARCH_FILES_PER_PAGE);
      const matches: Array<ReviewSearchMatch> = [];
      const unreadablePaths: Array<string> = [];
      let truncated = false;

      for (const file of page) {
        const text = yield* snapshot.read(revision, file).pipe(Effect.option);
        if (Option.isNone(text) || Option.isNone(text.value)) {
          if (unreadablePaths.length < MAX_UNREADABLE_PATHS) unreadablePaths.push(file);
          continue;
        }

        let found = 0;
        for (const [index, line] of text.value.value.split("\n").entries()) {
          if (!line.includes(query)) continue;
          if (found === SEARCH_LINES_PER_FILE) {
            truncated = true;
            break;
          }
          found += 1;
          matches.push(
            ReviewSearchMatch.make({
              path: file,
              line: index + 1,
              content: line.slice(0, MAX_MATCH_CHARS),
            }),
          );
        }
      }

      const next = cursor + SEARCH_FILES_PER_PAGE;
      return ReviewSearchResult.make({
        matches,
        truncated,
        unreadablePaths,
        ...(next < candidates.length ? { nextCursor: next } : {}),
      });
    }),
  });

export const layer = (snapshot: Snapshot) => Layer.succeed(ReviewRepository, make(snapshot));

/** A snapshot over in-memory maps, for tests and local runs. */
export const fromMaps = (files: Record<Revision, ReadonlyMap<string, string>>): Snapshot => ({
  paths: (revision) => Effect.succeed([...files[revision].keys()].sort()),
  read: (revision, path) => Effect.succeed(Option.fromNullishOr(files[revision].get(path))),
});
