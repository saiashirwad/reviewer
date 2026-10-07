import { Effect, Schema } from "effect";
import type { ParseOptions } from "effect/SchemaAST";

export const strictManifestOptions: ParseOptions = { onExcessProperty: "error" };

const slugSegmentIssue = { path: [] as const, issue: "invalid GitHub slug segment" };

const isSlugSegment = (segment: string): boolean => {
  if (segment.length === 0 || segment === "." || segment === "..") {
    return false;
  }
  for (const char of segment) {
    const code = char.charCodeAt(0);
    const ok = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || char === "-" || char === "_" || char === ".";
    if (!ok) {
      return false;
    }
  }
  return true;
};

const GitHubSlug = Schema.String.check(
  Schema.makeFilter((segment) => isSlugSegment(segment) ? undefined : slugSegmentIssue),
);

const SafeIdentifier = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)
      ? undefined
      : { path: [], issue: "expected a non-empty safe identifier" }
  ),
);

const HttpsOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { path: [], issue: "expected a valid HTTPS origin URL" };
    }
    if (url.protocol !== "https:") {
      return { path: [], issue: "expected an HTTPS URL" };
    }
    if (url.username !== "" || url.password !== "") {
      return { path: [], issue: "URL must not include credentials" };
    }
    if (url.search !== "" || url.hash !== "") {
      return { path: [], issue: "URL must not include query or hash" };
    }
    if (url.pathname !== "" && url.pathname !== "/") {
      return { path: [], issue: "URL must not include a path" };
    }
    return undefined;
  }),
);

const PullNumber = Schema.Int.check(
  Schema.makeFilter((n) =>
    n >= 1 && Number.isSafeInteger(n)
      ? undefined
      : { path: [], issue: "expected a positive safe integer" }
  ),
);

export const RepoRef = Schema.Struct({
  owner: GitHubSlug,
  repository: GitHubSlug,
});
export type RepoRef = typeof RepoRef.Type;

export const PullTarget = Schema.Struct({
  owner: GitHubSlug,
  repository: GitHubSlug,
  number: PullNumber,
});
export type PullTarget = typeof PullTarget.Type;

const RepoManifestEntry = Schema.Struct({
  owner: GitHubSlug,
  repository: GitHubSlug,
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

const decodeRepoRef = (owner: string, repository: string) =>
  Schema.decodeUnknownEffect(RepoRef)({ owner, repository });

const decodePullTarget = (owner: string, repository: string, number: number) =>
  Schema.decodeUnknownEffect(PullTarget)({ owner, repository, number });

const invalid = (input: string, message: string) =>
  Effect.fail(new InvalidTarget({ message, input }));

const parsePullNumber = (segment: string): number | undefined => {
  if (!/^\d+$/.test(segment)) {
    return undefined;
  }
  const value = Number(segment);
  if (!Number.isSafeInteger(value) || value < 1) {
    return undefined;
  }
  return value;
};

const githubPathSegments = (input: string): Effect.Effect<ReadonlyArray<string>, InvalidTarget> =>
  Effect.gen(function*() {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return yield* invalid(input, "expected a GitHub repository or pull request target");
    }
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    } catch {
      return yield* invalid(input, "expected a valid GitHub URL");
    }
    if (url.protocol !== "https:") {
      return yield* invalid(input, "expected an HTTPS GitHub URL");
    }
    if (url.username !== "" || url.password !== "") {
      return yield* invalid(input, "GitHub URL must not include credentials");
    }
    if (url.search !== "") {
      return yield* invalid(input, "GitHub URL must not include a query string");
    }
    if (url.hostname.toLowerCase() !== "github.com") {
      return yield* invalid(input, "expected a github.com URL");
    }
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => !isSlugSegment(segment))) {
      return yield* invalid(input, "invalid path in GitHub URL");
    }
    return segments;
  });

export const parseRepo = (
  input: string,
): Effect.Effect<RepoRef, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const trimmed = input.trim();
    if (trimmed.includes("#")) {
      return yield* invalid(input, "repository target must not include a pull number fragment");
    }
    if (trimmed.includes("://") || trimmed.toLowerCase().startsWith("github.com")) {
      const segments = yield* githubPathSegments(trimmed);
      if (segments.length !== 2) {
        return yield* invalid(input, "expected https://github.com/owner/repository");
      }
      const owner = segments[0];
      const repository = segments[1];
      if (owner === undefined || repository === undefined) {
        return yield* invalid(input, "expected https://github.com/owner/repository");
      }
      return yield* decodeRepoRef(owner, repository);
    }
    const slash = trimmed.indexOf("/");
    if (slash === -1) {
      return yield* invalid(input, "expected owner/repository");
    }
    const owner = trimmed.slice(0, slash);
    const repository = trimmed.slice(slash + 1);
    if (repository.includes("/") || repository.length === 0 || owner.length === 0) {
      return yield* invalid(input, "expected owner/repository");
    }
    return yield* decodeRepoRef(owner, repository);
  });

export const parsePull = (
  input: string,
): Effect.Effect<PullTarget, InvalidTarget | Schema.SchemaError> =>
  Effect.gen(function*() {
    const trimmed = input.trim();
    if (trimmed.includes("://") || trimmed.toLowerCase().startsWith("github.com")) {
      const segments = yield* githubPathSegments(trimmed);
      if (segments.length !== 4 || segments[2] !== "pull") {
        return yield* invalid(input, "expected https://github.com/owner/repository/pull/number");
      }
      const pullSegment = segments[3];
      const number = pullSegment === undefined ? undefined : parsePullNumber(pullSegment);
      if (number === undefined) {
        return yield* invalid(input, "expected a positive pull request number");
      }
      const owner = segments[0];
      const repository = segments[1];
      if (owner === undefined || repository === undefined) {
        return yield* invalid(input, "expected https://github.com/owner/repository/pull/number");
      }
      return yield* decodePullTarget(owner, repository, number);
    }
    const hash = trimmed.indexOf("#");
    if (hash === -1) {
      return yield* invalid(input, "expected owner/repository#number or a GitHub pull URL");
    }
    const repoPart = trimmed.slice(0, hash);
    const fragment = trimmed.slice(hash + 1);
    const numberSegment = fragment.split("#")[0]?.split("?")[0] ?? "";
    const number = parsePullNumber(numberSegment);
    if (number === undefined) {
      return yield* invalid(input, "expected a positive pull request number");
    }
    const repo = yield* parseRepo(repoPart);
    return yield* decodePullTarget(repo.owner, repo.repository, number);
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
