import { Schema } from "effect";

/** Review settings, layered: reviewer.config.ts defaults, then its repo entry, then the repo file. */
export interface Settings {
  readonly model: string;
  readonly guidance?: string;
  readonly exclude: ReadonlyArray<string>;
  /** Spending limit for one review, priced at OpenCode Go's per-model rates. */
  readonly maxCostUsd: number;
}

export interface RepoEntry extends Partial<Settings> {
  readonly owner: string;
  readonly repository: string;
}

export interface ReviewerConfig extends Partial<Settings> {
  readonly model: string;
  readonly repos: ReadonlyArray<RepoEntry>;
}

/** Read at the merge base, so a pull request cannot change how it is reviewed. */
export const REPO_FILE_PATH = ".github/reviewer.json";

export const DEFAULT_MAX_COST_USD = 0.5;

export const RepoFile = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NonEmptyString),
  maxCostUsd: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 5 }))),
  guidance: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type RepoFile = typeof RepoFile.Type;

export const DEFAULT_EXCLUDE: ReadonlyArray<string> = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
];

export const resolve = (config: ReviewerConfig, entry: RepoEntry): Settings => {
  const guidance = entry.guidance ?? config.guidance;
  return {
    model: entry.model ?? config.model,
    maxCostUsd: entry.maxCostUsd ?? config.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    exclude: [...DEFAULT_EXCLUDE, ...(config.exclude ?? []), ...(entry.exclude ?? [])],
    ...(guidance === undefined ? {} : { guidance }),
  };
};

export const applyRepoFile = (settings: Settings, file: RepoFile): Settings => {
  const guidance = file.guidance ?? settings.guidance;
  return {
    model: file.model ?? settings.model,
    maxCostUsd: file.maxCostUsd ?? settings.maxCostUsd,
    exclude: [...settings.exclude, ...(file.exclude ?? [])],
    ...(guidance === undefined ? {} : { guidance }),
  };
};

/**
 * `*` and `?` stay within one path segment and `**` spans segments. A pattern
 * without a slash also matches a file's basename anywhere in the tree.
 */
export const matcher = (patterns: ReadonlyArray<string>) => {
  const expressions = patterns.map((pattern) => {
    const source = pattern
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) =>
        part === "**/" || part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "[^/]"
              : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return { regex: new RegExp(`^${source}$`), basename: !pattern.includes("/") };
  });

  return (path: string) => {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    return expressions.some(
      ({ regex, basename: anywhere }) => regex.test(path) || (anywhere && regex.test(basename)),
    );
  };
};
