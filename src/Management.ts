import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";

export const strictManifestOptions: ParseOptions = { onExcessProperty: "error" };

const OwnerName = Schema.String.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
);

const RepositoryName = Schema.String.check(
  Schema.isPattern(/^(?!\.$)(?!\.\.$)[A-Za-z0-9._-]+$/),
);

const SafeIdentifier = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);

const HttpsOrigin = Schema.String.check(
  Schema.isPattern(/^https:\/\/[^/?#@:]+(?::443)?\/?$/),
);

const PullNumber = Schema.Int.check(
  Schema.makeFilter((n) =>
    n >= 1 && Number.isSafeInteger(n)
      ? undefined
      : { path: [], issue: "expected a positive safe integer" }
  ),
);

const PullDigits = Schema.String.check(Schema.isPattern(/^\d+$/));

const RepoPair = Schema.Tuple([OwnerName, RepositoryName]);
const PullTriple = Schema.Tuple([OwnerName, RepositoryName, PullDigits]);

export const RepoRef = Schema.Struct({
  owner: OwnerName,
  repository: RepositoryName,
});
export type RepoRef = typeof RepoRef.Type;

export const PullTarget = Schema.Struct({
  owner: OwnerName,
  repository: RepositoryName,
  number: PullNumber,
});
export type PullTarget = typeof PullTarget.Type;

const RepoManifestEntry = Schema.Struct({
  owner: OwnerName,
  repository: RepositoryName,
  model: Schema.optionalKey(Schema.NonEmptyString),
  guidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  maxCostUsd: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 5 })),
  ),
});
export type RepoManifestEntry = typeof RepoManifestEntry.Type;

export const Manifest = Schema.Struct({
  model: Schema.NonEmptyString,
  guidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  maxCostUsd: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 5 })),
  ),
  repos: Schema.Array(RepoManifestEntry),
  deployment: Schema.Struct({
    profile: SafeIdentifier,
    stage: SafeIdentifier,
    url: HttpsOrigin,
  }),
}).check(
  Schema.makeFilter((manifest) => {
    const seen = new Set<string>();
    for (const repo of manifest.repos) {
      const key = repoIdentityKey(repo);
      if (seen.has(key)) {
        return { path: ["repos"], issue: "duplicate repository entries" };
      }
      seen.add(key);
    }
    return undefined;
  }),
);
export type Manifest = typeof Manifest.Type;

export class InvalidTarget extends Schema.TaggedError<InvalidTarget>()("InvalidTarget", {
  message: Schema.String,
  input: Schema.String,
}) {}

export const repoIdentityKey = (ref: RepoRef): string =>
  `${ref.owner.toLowerCase()}/${ref.repository.toLowerCase()}`;

export const repoIdentityEquals = (left: RepoRef, right: RepoRef): boolean =>
  repoIdentityKey(left) === repoIdentityKey(right);

const invalid = (input: string, message: string) =>
  Effect.fail(new InvalidTarget({ message, input }));

const decodeRepoPair = (owner: string, repository: string) =>
  Schema.decodeUnknownEffect(RepoPair)([owner, repository]).pipe(
    Effect.map(([o, r]) => ({ owner: o, repository: r })),
  );

const decodePullParts = (owner: string, repository: string, digits: string) =>
  Effect.gen(function*() {
    const [o, r, d] = yield* Schema.decodeUnknownEffect(PullTriple)([owner, repository, digits]);
    const number = yield* Schema.decodeUnknownEffect(PullNumber)(Number(d));
    return { owner: o, repository: r, number };
  });

const isGitHubUrl = (input: string): boolean =>
  input.includes("://") || /^github\.com(?:[/:]|$)/i.test(input);

const toHttpsGitHub = (input: string): string => input.includes("://") ? input : `https://${input}`;

const rejectUnsafeGitHubUrl = (input: string, raw: string): Effect.Effect<void, InvalidTarget> =>
  Effect.gen(function*() {
    if (!/^https:\/\//i.test(raw)) {
      return yield* invalid(input, "expected an HTTPS GitHub URL");
    }
    if (/@/.test(raw)) {
      return yield* invalid(input, "GitHub URL must not include credentials");
    }
    if (/\?/.test(raw)) {
      return yield* invalid(input, "GitHub URL must not include a query string");
    }
    if (/github\.com:\d+/i.test(raw)) {
      return yield* invalid(input, "GitHub URL must not include a port");
    }
    if (/%2[eEfF]/.test(raw)) {
      return yield* invalid(input, "GitHub URL must not include encoded path segments");
    }
    const hostEnd = raw.search(/github\.com/i);
    if (hostEnd === -1) {
      return yield* invalid(input, "expected a github.com URL");
    }
    const pathStart = raw.indexOf("/", hostEnd + "github.com".length);
    const path = pathStart === -1 ? "" : raw.slice(pathStart);
    if (path.includes("//")) {
      return yield* invalid(input, "invalid path in GitHub URL");
    }
    for (const segment of path.split("/").filter((part) => part.length > 0)) {
      if (segment === "." || segment === ".." || /%2[eE]/i.test(segment)) {
        return yield* invalid(input, "invalid path in GitHub URL");
      }
    }
  });

const parseRepoUrl = (input: string): Effect.Effect<RepoRef, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const raw = toHttpsGitHub(input.trim());
    yield* rejectUnsafeGitHubUrl(input, raw);
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i.exec(raw);
    if (match === null) {
      return yield* invalid(input, "expected https://github.com/owner/repository");
    }
    const owner = match[1];
    const repository = match[2];
    if (owner === undefined || repository === undefined) {
      return yield* invalid(input, "expected https://github.com/owner/repository");
    }
    return yield* decodeRepoPair(owner, repository);
  });

const parsePullUrl = (
  input: string,
): Effect.Effect<PullTarget, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const raw = toHttpsGitHub(input.trim());
    yield* rejectUnsafeGitHubUrl(input, raw);
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:#.*)?$/i.exec(raw);
    if (match === null) {
      return yield* invalid(input, "expected https://github.com/owner/repository/pull/number");
    }
    const owner = match[1];
    const repository = match[2];
    const digits = match[3];
    if (owner === undefined || repository === undefined || digits === undefined) {
      return yield* invalid(input, "expected https://github.com/owner/repository/pull/number");
    }
    return yield* decodePullParts(owner, repository, digits);
  });

export const parseRepo = (
  input: string,
): Effect.Effect<RepoRef, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const trimmed = input.trim();
    if (isGitHubUrl(trimmed)) {
      return yield* parseRepoUrl(trimmed);
    }
    if (trimmed.includes("#") || trimmed.includes("?")) {
      return yield* invalid(input, "expected owner/repository");
    }
    const match = /^([^/]+)\/([^/]+)$/.exec(trimmed);
    if (match === null) {
      return yield* invalid(input, "expected owner/repository");
    }
    const owner = match[1];
    const repository = match[2];
    if (owner === undefined || repository === undefined) {
      return yield* invalid(input, "expected owner/repository");
    }
    return yield* decodeRepoPair(owner, repository);
  });

export const parsePull = (
  input: string,
): Effect.Effect<PullTarget, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const trimmed = input.trim();
    if (isGitHubUrl(trimmed)) {
      return yield* parsePullUrl(trimmed);
    }
    const match = /^([^/]+)\/([^/#]+)#(\d+)$/.exec(trimmed);
    if (match === null) {
      return yield* invalid(input, "expected owner/repository#number or a GitHub pull URL");
    }
    const owner = match[1];
    const repository = match[2];
    const digits = match[3];
    if (owner === undefined || repository === undefined || digits === undefined) {
      return yield* invalid(input, "expected owner/repository#number or a GitHub pull URL");
    }
    return yield* decodePullParts(owner, repository, digits);
  });

export const hasRepo = (manifest: Manifest, ref: RepoRef): boolean =>
  manifest.repos.some((entry) => repoIdentityEquals(entry, ref));

export const addRepo = (manifest: Manifest, ref: RepoRef): Manifest => {
  if (hasRepo(manifest, ref)) {
    return manifest;
  }
  return {
    ...manifest,
    repos: [...manifest.repos, { owner: ref.owner, repository: ref.repository }],
  };
};

export const removeRepo = (manifest: Manifest, ref: RepoRef): Manifest => {
  const key = repoIdentityKey(ref);
  const repos = manifest.repos.filter((entry) => repoIdentityKey(entry) !== key);
  if (repos.length === manifest.repos.length) {
    return manifest;
  }
  return { ...manifest, repos };
};
