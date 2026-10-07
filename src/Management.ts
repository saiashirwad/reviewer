import { Effect, Schema, SchemaTransformation } from "effect";
import type { ParseOptions } from "effect/SchemaAST";
import { RepoFile } from "./Settings.ts";

export const strictManifestOptions: ParseOptions = { onExcessProperty: "error" };

const OwnerName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
);

const RepositoryName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^(?!\.$)(?!\.\.$)[A-Za-z0-9._-]+$/),
);

const SafeIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
);

const HttpsOrigin = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isPattern(/^\S+$/),
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

const PullNumber = Schema.Int.check(Schema.isGreaterThan(0));

const PullDigits = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
  Schema.decodeTo(PullNumber, SchemaTransformation.numberFromString),
);

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

const settingOverrides = {
  model: RepoFile.fields.model,
  guidance: RepoFile.fields.guidance,
  exclude: RepoFile.fields.exclude,
  maxCostUsd: RepoFile.fields.maxCostUsd,
};

const RepoManifestEntry = Schema.Struct({ ...RepoRef.fields, ...settingOverrides });
export type RepoManifestEntry = typeof RepoManifestEntry.Type;

export const Manifest = Schema.Struct({
  ...settingOverrides,
  model: Schema.NonEmptyString,
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
  const [owner, repository, number] = yield* Schema.decodeUnknownEffect(PullTriple)(match.slice(1));
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
