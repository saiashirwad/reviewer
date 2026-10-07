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
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      if (
        url.protocol === "https:" && url.username === "" && url.password === ""
        && url.pathname === "/" && url.search === "" && url.hash === ""
      ) return undefined;
    } catch {
      return "expected an HTTPS origin without credentials, path, query, or fragment";
    }
    return "expected an HTTPS origin without credentials, path, query, or fragment";
  }),
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

const isGitHubUrl = (input: string): boolean =>
  input.includes("://") || /^github\.com(?:[/:]|$)/i.test(input);

const toHttpsGitHub = (input: string): string => input.includes("://") ? input : `https://${input}`;

export const parseRepo = Effect.fn("Management.parseRepo")(function*(input: string) {
  const trimmed = input.trim();
  const match = isGitHubUrl(trimmed)
    ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i.exec(toHttpsGitHub(trimmed))
    : /^([^/]+)\/([^/]+)$/.exec(trimmed);
  if (match === null) {
    return yield* invalid(input, "expected owner/repository or a github.com repository URL");
  }
  const [owner, repository] = yield* Schema.decodeUnknownEffect(RepoPair)(match.slice(1));
  return { owner, repository };
});

export const parsePull = Effect.fn("Management.parsePull")(function*(input: string) {
  const trimmed = input.trim();
  const match = isGitHubUrl(trimmed)
    ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:#.*)?$/i.exec(
      toHttpsGitHub(trimmed),
    )
    : /^([^/]+)\/([^/#]+)#(\d+)$/.exec(trimmed);
  if (match === null) {
    return yield* invalid(input, "expected owner/repository#number or a GitHub pull URL");
  }
  const [owner, repository, digits] = yield* Schema.decodeUnknownEffect(PullTriple)(match.slice(1));
  const number = yield* Schema.decodeUnknownEffect(PullNumber)(Number(digits));
  return { owner, repository, number };
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
