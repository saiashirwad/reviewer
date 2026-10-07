import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export interface RepositoryRef {
  readonly owner: string;
  readonly repository: string;
}

export interface PullRef extends RepositoryRef {
  readonly number: number;
}

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly operation: string;
  readonly status?: number;
  readonly message: string;
}> {}

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
});
export type PullRequest = typeof PullRequest.Type;

export const ChangedFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  patch: Schema.optionalKey(Schema.String),
  previous_filename: Schema.optionalKey(Schema.String),
});
export type ChangedFile = typeof ChangedFile.Type;

const Compare = Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Schema.String }) });
const Review = Schema.Struct({ body: Schema.NullOr(Schema.String) });

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** GitHub caps the pull request files listing at 3,000 entries. */
const MAX_FILE_PAGES = 30;

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly pull: (ref: PullRef) => Effect.Effect<PullRequest, GitHubError>;
    readonly mergeBase: (
      repo: RepositoryRef,
      base: string,
      head: string,
    ) => Effect.Effect<string, GitHubError>;
    readonly files: (ref: PullRef) => Effect.Effect<ReadonlyArray<ChangedFile>, GitHubError>;
    /** The gzipped tarball of `sha`, as a byte stream. */
    readonly tarball: (
      repo: RepositoryRef,
      sha: string,
    ) => Effect.Effect<ReadableStream<Uint8Array>, GitHubError>;
    readonly content: (
      repo: RepositoryRef,
      path: string,
      sha: string,
    ) => Effect.Effect<Option.Option<string>, GitHubError>;
    readonly reviewBodies: (ref: PullRef) => Effect.Effect<ReadonlyArray<string>, GitHubError>;
    readonly createReview: (
      ref: PullRef,
      input: {
        readonly commitId: string;
        readonly body: string;
        readonly comments: ReadonlyArray<ReviewComment>;
      },
    ) => Effect.Effect<void, GitHubError>;
  }
>()("reviewer/GitHub") {}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const make = Effect.fnUntraced(function* (token: Redacted.Redacted<string>) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.setHeaders({
          accept: request.headers.accept ?? "application/vnd.github+json",
          "user-agent": "reviewer/0.1",
          "x-github-api-version": "2022-11-28",
        }),
      ),
    ),
  );

  const fail = (operation: string) => (cause: unknown) => {
    const status =
      typeof cause === "object" && cause !== null && "response" in cause
        ? (cause as { response?: { status?: number } }).response?.status
        : undefined;
    return new GitHubError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      ...(status === undefined ? {} : { status }),
    });
  };

  const getJson = <S extends Schema.Top>(operation: string, url: string, schema: S) =>
    HttpClient.filterStatusOk(client)
      .get(url)
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError(fail(operation)),
      ) as Effect.Effect<S["Type"], GitHubError>;

  return GitHub.of({
    pull: ({ owner, repository, number }) =>
      getJson("pull", `/repos/${owner}/${repository}/pulls/${number}`, PullRequest),

    mergeBase: ({ owner, repository }, base, head) =>
      getJson(
        "mergeBase",
        `/repos/${owner}/${repository}/compare/${base}...${head}?per_page=1`,
        Compare,
      ).pipe(Effect.map((compare) => compare.merge_base_commit.sha)),

    files: Effect.fnUntraced(function* ({ owner, repository, number }) {
      const files: Array<ChangedFile> = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const batch = yield* getJson(
          "files",
          `/repos/${owner}/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
          Schema.Array(ChangedFile),
        );
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return files;
    }),

    tarball: ({ owner, repository }, sha) =>
      HttpClient.filterStatusOk(client)
        .get(`/repos/${owner}/${repository}/tarball/${sha}`)
        .pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.map((bytes) => new Blob([bytes]).stream()),
          Effect.mapError(fail("tarball")),
        ),

    content: ({ owner, repository }, path, sha) =>
      client
        .get(`/repos/${owner}/${repository}/contents/${encodePath(path)}?ref=${sha}`, {
          headers: { accept: "application/vnd.github.raw" },
        })
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeedNone
              : HttpClientResponse.filterStatusOk(response).pipe(
                  Effect.flatMap((ok) => ok.text),
                  Effect.map(Option.some),
                ),
          ),
          Effect.mapError(fail("content")),
        ),

    reviewBodies: ({ owner, repository, number }) =>
      getJson(
        "reviews",
        `/repos/${owner}/${repository}/pulls/${number}/reviews?per_page=100`,
        Schema.Array(Review),
      ).pipe(Effect.map((reviews) => reviews.flatMap(({ body }) => (body ? [body] : [])))),

    createReview: ({ owner, repository, number }, input) =>
      HttpClientRequest.post(`/repos/${owner}/${repository}/pulls/${number}/reviews`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          commit_id: input.commitId,
          event: "COMMENT",
          body: input.body,
          comments: input.comments.map((comment) => ({ ...comment, side: "RIGHT" })),
        }),
        HttpClient.filterStatusOk(client).execute,
        Effect.asVoid,
        Effect.mapError(fail("createReview")),
      ),
  });
});

export const layer = (token: Redacted.Redacted<string>) =>
  Layer.effect(GitHub, make(token)).pipe(Layer.provide(FetchHttpClient.layer));
