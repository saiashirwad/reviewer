import {
  ReviewContextError,
  ReviewFileList,
  ReviewRepository,
  ReviewSearchMatch,
  ReviewSearchResult,
  ReviewSource,
} from "@yielded/agent-pr-review/review-repository";
import { Effect, Option } from "effect";
import type { Revision, Snapshot } from "./snapshot/types.ts";

const MAX_LISTED_PATHS = 100;
const SEARCH_FILES_PER_PAGE = 20;
const SEARCH_LINES_PER_FILE = 5;
const MAX_MATCH_CHARS = 500;
const MAX_UNREADABLE_PATHS = 20;

const missing = (path: string, revision: Revision) =>
  ReviewContextError.make({ message: `${path} does not exist at ${revision}.` });

export const make = (snapshot: Snapshot) =>
  ReviewRepository.of({
    readFile: Effect.fn("ReviewContext.readFile")(
      function*(input) {
        const text = yield* snapshot.read(input.revision, input.path);
        if (Option.isNone(text)) return yield* missing(input.path, input.revision);
        return yield* ReviewSource.fromText(input, text.value);
      },
      (effect, input) =>
        effect.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Source read failed", {
              path: input.path,
              revision: input.revision,
              message: error.message,
            })
          ),
        ),
    ),

    findFiles: Effect.fn("ReviewContext.findFiles")(function*({ query, revision }) {
      const paths = yield* snapshot.paths(revision);
      const matches = paths.filter((path) => path.includes(query));
      return ReviewFileList.make({
        paths: matches.slice(0, MAX_LISTED_PATHS),
        truncated: matches.length > MAX_LISTED_PATHS,
      });
    }),

    searchCode: Effect.fn("ReviewContext.searchCode")(function*({ query, path, revision, cursor }) {
      const candidates = (yield* snapshot.paths(revision)).filter((p) => p.includes(path));
      const page = candidates.slice(cursor, cursor + SEARCH_FILES_PER_PAGE);
      const matches: Array<ReviewSearchMatch> = [];
      const unreadablePaths: Array<string> = [];
      let truncated = false;

      for (const file of page) {
        const text = yield* snapshot.read(revision, file).pipe(
          Effect.catchTag("ReviewContextError", () => Effect.succeedNone),
        );
        if (Option.isNone(text)) {
          if (unreadablePaths.length < MAX_UNREADABLE_PATHS) unreadablePaths.push(file);
          continue;
        }

        let found = 0;
        for (const [index, line] of text.value.split("\n").entries()) {
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
