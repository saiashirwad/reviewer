import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { PullRef, RepositoryRef, ReviewComment } from "./domain.ts";

export type { PullRef, RepositoryRef, ReviewComment };

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  message: Schema.String,
}) {}

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

const collectPages = Effect.fnUntraced(
  function*<A, E, R>(
    fetchPage: (page: number) => Effect.Effect<ReadonlyArray<A>, E, R>,
    maxPages = Number.POSITIVE_INFINITY,
  ) {
    const collected: Array<A> = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = yield* fetchPage(page);
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  },
);

const toGitHubError = (operation: string) => (cause: unknown): GitHubError => {
  if (HttpClientError.isHttpClientError(cause)) {
    const status = cause.response?.status;
    return new GitHubError({
      operation,
      message: cause.message,
      ...(status === undefined ? {} : { status }),
    });
  }
  return new GitHubError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
};

export const make = Effect.fn("GitHub.make")(function*(token: Redacted.Redacted<string>) {
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
      )
    ),
  );

  const okClient = HttpClient.filterStatusOk(client);

  const getJson = <S extends Schema.Top>(operation: string, url: string, schema: S) =>
    okClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(toGitHubError(operation)),
    );

  return GitHub.of({
    pull: Effect.fn("GitHub.pull")(function*({ owner, repository, number }) {
      return yield* getJson("pull", `/repos/${owner}/${repository}/pulls/${number}`, PullRequest);
    }),

    mergeBase: Effect.fn("GitHub.mergeBase")(function*({ owner, repository }, base, head) {
      const compare = yield* getJson(
        "mergeBase",
        `/repos/${owner}/${repository}/compare/${base}...${head}?per_page=1`,
        Compare,
      );
      return compare.merge_base_commit.sha;
    }),

    files: Effect.fn("GitHub.files")(function*({ owner, repository, number }) {
      return yield* collectPages(
        (page) =>
          getJson(
            "files",
            `/repos/${owner}/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
            Schema.Array(ChangedFile),
          ),
        MAX_FILE_PAGES,
      );
    }),

    tarball: Effect.fn("GitHub.tarball")(function*({ owner, repository }, sha) {
      const response = yield* okClient.get(`/repos/${owner}/${repository}/tarball/${sha}`);
      const bytes = yield* response.arrayBuffer;
      return new Blob([bytes]).stream();
    }, Effect.mapError(toGitHubError("tarball"))),

    content: Effect.fn("GitHub.content")(function*({ owner, repository }, path, sha) {
      const response = yield* client.get(
        `/repos/${owner}/${repository}/contents/${encodePath(path)}?ref=${sha}`,
        { headers: { accept: "application/vnd.github.raw" } },
      );
      if (response.status === 404) {
        return Option.none();
      }
      const ok = yield* HttpClientResponse.filterStatusOk(response);
      const text = yield* ok.text;
      return Option.some(text);
    }, Effect.mapError(toGitHubError("content"))),

    reviewBodies: Effect.fn("GitHub.reviewBodies")(function*({ owner, repository, number }) {
      const reviews = yield* collectPages((page) =>
        getJson(
          "reviews",
          `/repos/${owner}/${repository}/pulls/${number}/reviews?per_page=100&page=${page}`,
          Schema.Array(Review),
        )
      );
      return reviews.flatMap(({ body }) => (body ? [body] : []));
    }),

    createReview: Effect.fn("GitHub.createReview")(function*({ owner, repository, number }, input) {
      yield* HttpClientRequest.post(`/repos/${owner}/${repository}/pulls/${number}/reviews`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          commit_id: input.commitId,
          event: "COMMENT",
          body: input.body,
          comments: input.comments.map((comment) => ({ ...comment, side: "RIGHT" })),
        }),
        okClient.execute,
        Effect.asVoid,
        Effect.mapError(toGitHubError("createReview")),
      );
    }),
  });
});

export const layer = (token: Redacted.Redacted<string>) =>
  Layer.effect(GitHub, make(token)).pipe(Layer.provide(FetchHttpClient.layer));
