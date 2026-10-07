import { Console, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { open } from "node:fs/promises";
import * as Management from "../../src/Management.ts";
import { marker } from "../../src/Publish.ts";
import { CliError, githubToken, opencodeKey, Runtime } from "./Runtime.ts";

const MANIFEST = "reviewer.json";
const LOCK = "reviewer.json.lock";
const TEMP = "reviewer.json.tmp";

export type CommandBase = { readonly baseDir?: string; };
const resolveBase = (options?: CommandBase): string => options?.baseDir ?? process.cwd();

const ManifestJson = Schema.fromJsonString(Management.Manifest);

type ManifestPaths = { manifest: string; lock: string; temp: string; };

const manifestPathsFor = Effect.fn("Commands.manifestPathsFor")(function*(baseDir: string) {
  const path = yield* Path.Path;
  const base = path.resolve(baseDir);
  return {
    manifest: path.join(base, MANIFEST),
    lock: path.join(base, LOCK),
    temp: path.join(base, TEMP),
  };
});

const decodeManifestString = (content: string) =>
  Schema.decodeUnknownEffect(ManifestJson)(content, Management.strictManifestOptions).pipe(
    Effect.mapError(() => new CliError({ message: "Invalid reviewer.json" })),
  );

const readManifestFile = Effect.fn("Commands.readManifestFile")(function*(manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(manifestPath).pipe(
    Effect.mapError(() =>
      new CliError({
        message:
          `Cannot read ${MANIFEST}; run from the project directory and check file permissions`,
      })
    ),
  );
  return yield* decodeManifestString(content);
});

export const loadManifest = Effect.fn("Commands.loadManifest")(function*(options?: CommandBase) {
  const paths = yield* manifestPathsFor(resolveBase(options));
  return yield* readManifestFile(paths.manifest);
});

const writeManifestAtomic = Effect.fn("Commands.writeManifestAtomic")(function*(
  manifestPath: string,
  tempPath: string,
  manifest: Management.Manifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const json = JSON.stringify(manifest, null, 2) + "\n";
  yield* fs.writeFileString(tempPath, json).pipe(
    Effect.mapError(() => new CliError({ message: `Failed to write ${MANIFEST}` })),
  );
  yield* fs.rename(tempPath, manifestPath).pipe(
    Effect.mapError(() => new CliError({ message: `Failed to save ${MANIFEST}` })),
  );
});

const NodeEexist = Schema.Struct({ code: Schema.Literal("EEXIST") });
const isEexist = Schema.is(NodeEexist);

const lockHeldError = new CliError({
  message:
    `${LOCK} is held or stale; wait for the other reviewer command or remove ${LOCK} if a prior command was killed`,
});

const withManifestLock = <A, E, R>(
  baseDir: string,
  use: (manifest: Management.Manifest, paths: ManifestPaths) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const paths = yield* manifestPathsFor(baseDir);
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => open(paths.lock, "wx"),
          catch: (error) => (isEexist(error)
            ? lockHeldError
            : new CliError({ message: `Failed to lock ${MANIFEST}` })),
        }),
        (h) =>
          Effect.gen(function*() {
            yield* Effect.tryPromise({
              try: () => h.close(),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            yield* fs.remove(paths.lock, { recursive: false }).pipe(Effect.ignore);
            yield* fs.remove(paths.temp, { recursive: false }).pipe(Effect.ignore);
          }),
      );
      const manifest = yield* readManifestFile(paths.manifest);
      return yield* use(manifest, paths);
    }),
  );

const ghEnv = (token: Redacted.Redacted<string>): Record<string, string> => {
  const value = Redacted.value(token);
  return { GH_TOKEN: value, GITHUB_TOKEN: value };
};

type GhRunOptions = { paginate?: boolean; method?: string; fields?: ReadonlyArray<string>; };

const CliPull = Schema.Struct({
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean,
  head: Schema.Struct({ sha: Schema.NonEmptyString }),
});

const Hook = Schema.Struct({
  active: Schema.Boolean,
  events: Schema.Array(Schema.String),
  config: Schema.Struct({ url: Schema.optionalKey(Schema.String) }),
});
const HookPages = Schema.Array(Schema.Array(Hook));
type HookPagesType = typeof HookPages.Type;

const GhUser = Schema.Struct({ login: Schema.String });
const RepoMeta = Schema.Struct({
  permissions: Schema.optionalKey(
    Schema.Struct({
      push: Schema.optionalKey(Schema.Boolean),
      admin: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  owner: Schema.Struct({ login: Schema.String, type: Schema.String }),
});
const CommentResponse = Schema.Struct({ html_url: Schema.String });
const ReviewPages = Schema.Array(
  Schema.Array(Schema.Struct({ body: Schema.NullOr(Schema.String) })),
);

type GhRun = (endpoint: string, options?: GhRunOptions) => Effect.Effect<string, CliError>;

const ghDecode = <S extends Schema.Constraint>(
  schema: S,
  output: string,
  message = "Unexpected response from GitHub",
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output).pipe(
    Effect.mapError(() => new CliError({ message })),
  );

const ghJson = <S extends Schema.Constraint>(
  runGh: GhRun,
  endpoint: string,
  schema: S,
  options?: GhRunOptions,
) => runGh(endpoint, options).pipe(Effect.flatMap((output) => ghDecode(schema, output)));

type GithubClient = {
  readonly runGh: GhRun;
  readonly noBody: (endpoint: string) => Effect.Effect<void, CliError>;
  readonly postField: (
    endpoint: string,
    field: string,
    value: string,
  ) => Effect.Effect<string, CliError>;
};

const makeGithubClient = Effect.fn("Commands.makeGithubClient")(function*(
  token: Redacted.Redacted<string>,
) {
  const runtime = yield* Runtime;
  const env = ghEnv(token);
  const runGh = (endpoint: string, options?: GhRunOptions) => {
    const args = [
      "api",
      "--hostname",
      "github.com",
      endpoint,
      ...(options?.paginate ? ["--paginate", "--slurp"] : []),
      ...(options?.method ? ["--method", options.method] : []),
      ...(options?.fields ?? []),
    ];
    return runtime.run("gh", args, { env });
  };
  const client = {
    runGh,
    noBody: (endpoint: string) =>
      Effect.gen(function*() {
        const output = yield* runGh(endpoint);
        if (output.trim().length > 0) {
          return yield* Effect.fail(new CliError({ message: "Unexpected response from GitHub" }));
        }
      }),
    postField: (endpoint: string, field: string, value: string) =>
      runGh(endpoint, { method: "POST", fields: ["--field", `${field}=${value}`] }),
  } satisfies GithubClient;
  return client;
});

type HooksFetch =
  | { readonly _tag: "Success"; readonly pages: HookPagesType; }
  | { readonly _tag: "Failed"; };

const hasWebhookEvents = (events: ReadonlyArray<string>): boolean =>
  events.includes("*")
  || (events.includes("pull_request") && events.includes("issue_comment"));

export const expectedHookUrl = (
  deploymentUrl: string,
  owner: string,
  repository: string,
): string => `${new URL(deploymentUrl).origin}/__alchemy/github/${owner}/${repository}`;

const findActiveHook = (
  pages: HookPagesType,
  deploymentUrl: string,
  owner: string,
  repository: string,
) => {
  const target = expectedHookUrl(deploymentUrl, owner, repository);
  for (const page of pages) {
    for (const hook of page) {
      const url = hook.config.url;
      if (url === target && hook.active && hasWebhookEvents(hook.events)) {
        return hook;
      }
    }
  }
  return undefined;
};

const fetchRepoHooks = (
  gh: GithubClient,
  owner: string,
  repository: string,
): Effect.Effect<HooksFetch, never> =>
  ghJson(gh.runGh, `repos/${owner}/${repository}/hooks`, HookPages, { paginate: true }).pipe(
    Effect.map((pages) => ({ _tag: "Success" as const, pages })),
    Effect.catch(() => Effect.succeed({ _tag: "Failed" as const })),
  );

const enrolledEntry = (manifest: Management.Manifest, target: Management.RepoRef) => {
  const key = Management.repoIdentityKey(target);
  return manifest.repos.find((entry) => Management.repoIdentityKey(entry) === key);
};

const REPO_FORMAT = "expected owner/repository or https://github.com/owner/repository";
const PULL_FORMAT =
  "expected owner/repository#number or https://github.com/owner/repository/pull/number";

const parseRepoInput = (input: string) =>
  Management.parseRepo(input).pipe(
    Effect.catch((error) =>
      Effect.fail(
        new CliError({
          message: error instanceof Management.InvalidTarget
            ? `${error.message}; ${REPO_FORMAT}`
            : `Invalid repository; ${REPO_FORMAT}`,
        }),
      )
    ),
  );

const parsePullInput = (input: string) =>
  Management.parsePull(input).pipe(
    Effect.catch((error) =>
      Effect.fail(
        new CliError({
          message: error instanceof Management.InvalidTarget
            ? `${error.message}; ${PULL_FORMAT}`
            : `Invalid pull request; ${PULL_FORMAT}`,
        }),
      )
    ),
  );

const alchemyDeploy = Effect.fn("Commands.alchemyDeploy")(function*(manifest: Management.Manifest) {
  const { profile, stage, url } = manifest.deployment;
  yield* Console.log(`Deploying profile=${profile} stage=${stage} url=${url}`);
  const runtime = yield* Runtime;
  const token = yield* githubToken;
  const key = yield* opencodeKey;
  yield* runtime
    .run(
      "pnpm",
      ["exec", "alchemy", "deploy", "--profile", profile, "--stage", stage, "--yes"],
      {
        env: {
          GITHUB_TOKEN: Redacted.value(token),
          OPENCODE_API_KEY: Redacted.value(key),
        },
        inherit: true,
      },
    )
    .pipe(
      Effect.catch(() =>
        Effect.fail(
          new CliError({
            message:
              "Deploy failed; reviewer.json is retained. Alchemy may have applied partial changes. Run pnpm reviewer status, then retry pnpm reviewer deploy",
          }),
        )
      ),
    );
});

export const reposList = Effect.fn("Commands.reposList")(function*(options?: CommandBase) {
  const manifest = yield* loadManifest(options);
  if (manifest.repos.length === 0) {
    yield* Console.log("Configured repositories: none");
    return;
  }
  for (const repo of manifest.repos) {
    yield* Console.log(`${repo.owner}/${repo.repository}`);
  }
});

export const reposAdd = Effect.fn("Commands.reposAdd")(function*(
  input: string,
  deploy: boolean,
  options?: CommandBase,
) {
  const baseDir = resolveBase(options);
  const ref = yield* parseRepoInput(input);
  const label = `${ref.owner}/${ref.repository}`;
  yield* withManifestLock(baseDir, (current, paths) =>
    Effect.gen(function*() {
      const existed = Management.hasRepo(current, ref);
      const next = Management.addRepo(current, ref);
      if (existed) {
        yield* Console.log(`Configured locally (unchanged): ${label}`);
      } else {
        yield* writeManifestAtomic(paths.manifest, paths.temp, next);
        yield* Console.log(`Configured locally: ${label} (run pnpm reviewer deploy to enroll)`);
      }
      if (deploy) {
        yield* alchemyDeploy(next);
        yield* Console.log("Deploy completed; run reviewer status to verify webhooks");
      }
    }));
});

export const reposRemove = Effect.fn("Commands.reposRemove")(function*(
  input: string,
  deploy: boolean,
  options?: CommandBase,
) {
  const baseDir = resolveBase(options);
  const ref = yield* parseRepoInput(input);
  const label = `${ref.owner}/${ref.repository}`;
  yield* withManifestLock(baseDir, (current, paths) =>
    Effect.gen(function*() {
      const next = Management.removeRepo(current, ref);
      if (next.repos.length === current.repos.length) {
        yield* Console.log(`Not locally configured (unchanged): ${label}`);
      } else {
        yield* writeManifestAtomic(paths.manifest, paths.temp, next);
        yield* Console.log(
          `Removed locally: ${label} (run pnpm reviewer deploy to update enrollment)`,
        );
      }
      if (deploy) {
        yield* alchemyDeploy(next);
        yield* Console.log("Deploy completed; run reviewer status to verify webhooks");
      }
    }));
});

export const deployCommand = Effect.fn("Commands.deploy")(function*(options?: CommandBase) {
  const baseDir = resolveBase(options);
  yield* withManifestLock(baseDir, (locked) => alchemyDeploy(locked));
  yield* Console.log("Deploy completed; run pnpm reviewer status to verify webhooks");
});

export const statusCommand = Effect.fn("Commands.status")(function*(options?: CommandBase) {
  const manifest = yield* loadManifest(options);
  const { deployment } = manifest;
  const token = yield* githubToken;
  const gh = yield* makeGithubClient(token);
  const runtime = yield* Runtime;
  yield* Console.log(
    `Target url=${deployment.url} profile=${deployment.profile} stage=${deployment.stage}`,
  );
  const health = yield* runtime.health(deployment.url).pipe(
    Effect.match({
      onFailure: () => ({ ok: false, unavailable: true }),
      onSuccess: (value) => ({ ok: value, unavailable: false }),
    }),
  );
  if (health.unavailable) {
    yield* Console.log("Worker health: unavailable");
  } else {
    yield* Console.log(`Worker health: ${health.ok ? "ok" : "unhealthy"}`);
  }
  let unhealthy = health.unavailable || !health.ok;
  if (manifest.repos.length === 0) {
    yield* Console.log(
      "Locally configured repositories: none (does not reflect remote enrollment)",
    );
  } else {
    for (const repo of manifest.repos) {
      yield* Console.log(`Locally configured: ${repo.owner}/${repo.repository}`);
    }
  }
  for (const repo of manifest.repos) {
    const label = `${repo.owner}/${repo.repository}`;
    const expected = expectedHookUrl(deployment.url, repo.owner, repo.repository);
    yield* Console.log(`Webhook ${label} expected=${expected}`);
    const hooks = yield* fetchRepoHooks(gh, repo.owner, repo.repository);
    if (hooks._tag === "Failed") {
      yield* Console.log(`Webhook ${label} active=unknown`);
      unhealthy = true;
      continue;
    }
    const hook = findActiveHook(hooks.pages, deployment.url, repo.owner, repo.repository);
    if (hook === undefined) {
      yield* Console.log(`Webhook ${label} active=missing`);
      unhealthy = true;
    } else {
      yield* Console.log(`Webhook ${label} active=${hook.config.url}`);
    }
  }
  if (unhealthy) {
    return yield* Effect.fail(
      new CliError({
        message:
          "Status checks failed; deploy pending configuration or check credentials and Worker health",
      }),
    );
  }
});

const authorizeRequest = Effect.fn("Commands.authorizeRequest")(
  function*(gh: GithubClient, owner: string, repository: string, login: string) {
    if (login.toLowerCase() === owner.toLowerCase()) {
      return;
    }
    const repo = yield* ghJson(gh.runGh, `repos/${owner}/${repository}`, RepoMeta);
    if (repo.permissions?.push === true || repo.permissions?.admin === true) {
      return;
    }
    if (repo.owner.type === "Organization") {
      const member = yield* gh.noBody(`orgs/${owner}/members/${login}`).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      );
      if (member) {
        return;
      }
    }
    return yield* Effect.fail(
      new CliError({
        message:
          `Cannot confirm permission for ${login} on ${owner}/${repository}; post /review on GitHub directly if you are trusted`,
      }),
    );
  },
);

const skipPull = (number: number, reason: string) =>
  Console.log(`Skipped pull request #${number}: ${reason}`);

export const requestCommand = Effect.fn("Commands.request")(function*(
  pullInput: string,
  options?: CommandBase,
) {
  const manifest = yield* loadManifest(options);
  const pull = yield* parsePullInput(pullInput);
  const entry = enrolledEntry(manifest, pull);
  if (entry === undefined) {
    return yield* Effect.fail(
      new CliError({
        message:
          `${pull.owner}/${pull.repository} is not in reviewer.json; enroll with reviewer repos add --deploy`,
      }),
    );
  }
  const owner = entry.owner;
  const repository = entry.repository;
  const token = yield* githubToken;
  const gh = yield* makeGithubClient(token);
  const hooks = yield* fetchRepoHooks(gh, owner, repository);
  if (hooks._tag === "Failed") {
    return yield* Effect.fail(
      new CliError({
        message: `Cannot verify webhook for ${owner}/${repository}; check GitHub token access`,
      }),
    );
  }
  if (findActiveHook(hooks.pages, manifest.deployment.url, owner, repository) === undefined) {
    return yield* Effect.fail(
      new CliError({
        message:
          `No active enrollment webhook for ${owner}/${repository}; deploy with reviewer repos add --deploy`,
      }),
    );
  }
  const user = yield* ghJson(gh.runGh, "user", GhUser);
  yield* authorizeRequest(gh, owner, repository, user.login);
  const pr = yield* ghJson(gh.runGh, `repos/${owner}/${repository}/pulls/${pull.number}`, CliPull);
  if (pr.state !== "open") {
    yield* skipPull(pull.number, "closed");
    return;
  }
  if (pr.draft === true) {
    yield* skipPull(pull.number, "draft");
    return;
  }
  const headSha = pr.head.sha;
  const reviewPages = yield* ghJson(
    gh.runGh,
    `repos/${owner}/${repository}/pulls/${pull.number}/reviews`,
    ReviewPages,
    { paginate: true },
  );
  const reviewMarker = marker(headSha);
  for (const page of reviewPages) {
    for (const review of page) {
      if (review.body?.includes(reviewMarker)) {
        yield* Console.log(`Skipped pull request #${pull.number}; head already reviewed`);
        return;
      }
    }
  }
  const latest = yield* ghJson(
    gh.runGh,
    `repos/${owner}/${repository}/pulls/${pull.number}`,
    CliPull,
  );
  if (latest.state !== "open") {
    yield* skipPull(pull.number, "closed");
    return;
  }
  if (latest.draft === true) {
    yield* skipPull(pull.number, "draft");
    return;
  }
  if (latest.head.sha !== headSha) {
    return yield* Effect.fail(
      new CliError({
        message: `Pull request head changed to ${
          latest.head.sha.slice(0, 7)
        } during checks; rerun reviewer request for the latest head`,
      }),
    );
  }
  const responseJson = yield* gh.postField(
    `repos/${owner}/${repository}/issues/${pull.number}/comments`,
    "body",
    "/review",
  ).pipe(
    Effect.catch(() =>
      Effect.fail(
        new CliError({
          message:
            "Failed to submit review request; GitHub may have accepted the comment before a transport error",
        }),
      )
    ),
  );
  const comment = yield* ghDecode(
    CommentResponse,
    responseJson,
    "GitHub returned an unexpected comment response; check the PR conversation before retrying",
  );
  yield* Console.log(`Request submitted: ${comment.html_url}`);
});

const deployFlag = Flag.Boolean("deploy").pipe(
  Flag.withDescription("Deploy after updating reviewer.json"),
  Flag.withDefault(false),
);

const repos = Command.make("repos").pipe(
  Command.withDescription("Manage locally configured repositories"),
);

const reposListCmd = Command.make("list", {}, () => reposList()).pipe(
  Command.withDescription("List locally configured repositories"),
);

const reposAddCmd = Command.make(
  "add",
  { repo: Argument.String("repo"), deploy: deployFlag },
  ({ repo, deploy }) => reposAdd(repo, deploy),
).pipe(Command.withDescription("Add a repository to reviewer.json"));

const reposRemoveCmd = Command.make(
  "remove",
  { repo: Argument.String("repo"), deploy: deployFlag },
  ({ repo, deploy }) => reposRemove(repo, deploy),
).pipe(Command.withDescription("Remove a repository from reviewer.json"));

const deployCmd = Command.make("deploy", {}, () => deployCommand()).pipe(
  Command.withDescription("Deploy the saved reviewer target with Alchemy"),
);

const statusCmd = Command.make("status", {}, () => statusCommand()).pipe(
  Command.withDescription("Check Worker health and enrollment webhooks"),
);

const requestCmd = Command.make(
  "request",
  { pull: Argument.String("pull") },
  ({ pull }) => requestCommand(pull),
).pipe(Command.withDescription("Request a review via a /review comment on a pull request"));

export const rootCommand = Command.make("reviewer").pipe(
  Command.withDescription("Manage reviewer deployment and repositories"),
  Command.withSubcommands([
    repos.pipe(Command.withSubcommands([reposListCmd, reposAddCmd, reposRemoveCmd])),
    deployCmd,
    statusCmd,
    requestCmd,
  ]),
);
