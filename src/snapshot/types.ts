import { ReviewContextError } from "@yielded/agent-pr-review/review-repository";
import { Effect, Option } from "effect";

export type Revision = "base" | "head";

/** Read-only access to the two revisions under review. Paths are sorted. */
export interface Snapshot {
  readonly paths: (revision: Revision) => Effect.Effect<ReadonlyArray<string>, ReviewContextError>;
  readonly read: (
    revision: Revision,
    path: string,
  ) => Effect.Effect<Option.Option<string>, ReviewContextError>;
}

/** In-memory snapshot for tests and local smoke runs. */
export const fromMaps = (files: Record<Revision, ReadonlyMap<string, string>>): Snapshot => ({
  paths: (revision) => Effect.succeed([...files[revision].keys()].sort()),
  read: (revision, path) => Effect.succeed(Option.fromNullishOr(files[revision].get(path))),
});

/** Binary or oversized files cannot be read as text. */
export const MAX_FILE_BYTES = 256 * 1024;
