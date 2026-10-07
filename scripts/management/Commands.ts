import { Console, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { open } from "node:fs/promises";
import * as Management from "../../src/Management.ts";
import { marker } from "../../src/Publish.ts";
import { CliError, githubToken, opencodeKey, Runtime } from "./Runtime.ts";

const MANIFEST = "reviewer.json";
const LOCK = "reviewer.json.lock";
const TEMP = "reviewer.json.tmp";

const ManifestJson = Schema.fromJsonString(Management.Manifest);

const decodeManifestString = (content: string) =>
  Schema.decodeUnknownEffect(ManifestJson)(content, Management.strictManifestOptions).pipe(
    Effect.mapError(() => new CliError({ message: "Invalid reviewer.json" })),
  );

const manifestPaths = Effect.gen(function*() {
  const path = yield* Path.Path;
  const base = path.resolve(process.cwd());
  return {
    manifest: path.join(base, MANIFEST),
    lock: path.join(base, LOCK),
    temp: path.join(base, TEMP),
  };
});

const readManifestFile = (manifestPath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(manifestPath).pipe(
      Effect.mapError(() =>
        new CliError({ message: `Missing ${MANIFEST} in the current directory` })
      ),
    );
    return yield* decodeManifestString(content);
  });

export const loadManifest = Effect.fn("Commands.loadManifest")(function*() {
  const paths = yield* manifestPaths;
  return yield* readManifestFile(paths.manifest);
});

const writeManifestAtomic = (
  manifestPath: string,
  tempPath: string,
  manifest: Management.Manifest,
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    const json = JSON.stringify(manifest, null, 2) + "\n";
    yield* fs.writeFileString(tempPath, json).pipe(
      Effect.mapError(() => new CliError({ message: `Failed to write ${MANIFEST}` })),
    );
    yield* fs.rename(tempPath, manifestPath).pipe(
      Effect.mapError(() => new CliError({ message: `Failed to save ${MANIFEST}` })),
    );
  });

const isEexist = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";

const releaseLock = (lockPath: string, handle: Awaited<ReturnType<typeof open>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.tryPromise({
      try: () => handle.close(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    yield* fs.remove(lockPath, { recursive: false }).pipe(Effect.ignore);
  });

const withManifestLock = <A, E, R>(
  use: (manifest: Management.Manifest) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function*() {
    const paths = yield* manifestPaths;
    const handle = yield* Effect.tryPromise({
      try: () => open(paths.lock, "wx"),
      catch: (error) =>
        isEexist(error)
          ? new CliError({
            message: `${MANIFEST} is locked; wait for the other reviewer command to finish`,
          })
          : new CliError({ message: `Failed to lock ${MANIFEST}` }),
    });
    return yield* Effect.gen(function*() {
      const manifest = yield* readManifestFile(paths.manifest);
      return yield* use(manifest);
    }).pipe(Effect.ensuring(releaseLock(paths.lock, handle)));
  });

const updateManifest = (
  mutate: (manifest: Management.Manifest) => Management.Manifest,
) =>
  withManifestLock((manifest) =>
    Effect.gen(function*() {
      const paths = yield* manifestPaths;
      const next = mutate(manifest);
      yield* writeManifestAtomic(paths.manifest, paths.temp, next);
      return next;
    })
  );

const ghEnv = (token: Redacted.Redacted<string>) => {
  const value = Redacted.value(token);
  return { GH_TOKEN: value, GITHUB_TOKEN: value };
};

const CliPull = Schema.Struct({
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  head: Schema.Struct({ sha: Schema.String }),
});

const Hook = Schema.Struct({
  active: Schema.Boolean,
  events: Schema.Array(Schema.String),
  config: Schema.Struct({ url: Schema.String }),
});
const HookPages = Schema.Array(Schema.Array(Hook));

const hasWebhookEvents = (events: ReadonlyArray<string>): boolean =>
  events.includes("*")
  || (events.includes("pull_request") && events.includes("issue_comment"));

export const expectedHookUrl = (
  deploymentUrl: string,
  owner: string,
  repository: string,
): string => `${new URL(deploymentUrl).origin}/__alchemy/github/${owner}/${repository}`;

const findActiveHook = (
  pages: typeof HookPages.Type,
  deploymentUrl: string,
  owner: string,
  repository: string,
) => {
  const target = expectedHookUrl(deploymentUrl, owner, repository);
  for (const page of pages) {
    for (const hook of page) {
      if (hook.config.url === target && hook.active && hasWebhookEvents(hook.events)) {
        return hook;
      }
    }
  }
  return undefined;
};

const ghApiJson = Effect.fn("Commands.ghApiJson")(function*(
  endpoint: string,
  options?: { paginate?: boolean; method?: string; fields?: ReadonlyArray<string>; },
) {
  const runtime = yield* Runtime;
  const token = yield* githubToken;
  const args = [
    "api",
    "--hostname",
    "github.com",
    endpoint,
    ...(options?.paginate ? ["--paginate", "--slurp"] : []),
    ...(options?.method ? ["--method", options.method] : []),
    ...(options?.fields ?? []),
  ];
  const output = yield* runtime.run("gh", args, { env: ghEnv(token) });
  return JSON.parse(output) as unknown;
});

const fetchRepoHooks = (owner: string, repository: string) =>
  ghApiJson(`repos/${owner}/${repository}/hooks`, { paginate: true }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(HookPages)(json)),
    Effect.map((pages) => ({ pages, failed: false as const })),
    Effect.catch(() => Effect.succeed({ pages: undefined, failed: true as const })),
  );

const enrolledEntry = (manifest: Management.Manifest, target: Management.RepoRef) => {
  const key = Management.repoIdentityKey(target);
  return manifest.repos.find((entry) => Management.repoIdentityKey(entry) === key);
};

const cliInputError = (error: unknown) =>
  new CliError({
    message: error instanceof Management.InvalidTarget ? error.message : "Invalid input",
  });

const parseRepoInput = (input: string) =>
  Management.parseRepo(input).pipe(Effect.catch((error) => Effect.fail(cliInputError(error))));

const parsePullInput = (input: string) =>
  Management.parsePull(input).pipe(Effect.catch((error) => Effect.fail(cliInputError(error))));

export const reposList = Effect.fn("Commands.reposList")(function*() {
  const manifest = yield* loadManifest();
  for (const repo of manifest.repos) {
    yield* Console.log(`${repo.owner}/${repo.repository}`);
  }
});

export const reposAdd = Effect.fn("Commands.reposAdd")(function*(
  input: string,
  deploy: boolean,
) {
  const ref = yield* parseRepoInput(input);
  const manifest = yield* updateManifest((current) => Management.addRepo(current, ref));
  if (deploy) {
    yield* deployManifest(manifest);
  }
});

export const reposRemove = Effect.fn("Commands.reposRemove")(function*(
  input: string,
  deploy: boolean,
) {
  const ref = yield* parseRepoInput(input);
  const manifest = yield* updateManifest((current) => Management.removeRepo(current, ref));
  if (deploy) {
    yield* deployManifest(manifest);
  }
});

export const deployManifest = Effect.fn("Commands.deployManifest")(
  function*(manifest?: Management.Manifest) {
    const resolved = manifest ?? (yield* loadManifest());
    const { profile, stage, url } = resolved.deployment;
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
                "Deploy failed; local reviewer.json changes are saved. Run reviewer status, then retry with reviewer deploy",
            }),
          )
        ),
      );
  },
);

export const deployCommand = Effect.fn("Commands.deploy")(function*() {
  yield* deployManifest();
});

export const statusCommand = Effect.fn("Commands.status")(function*() {
  const manifest = yield* loadManifest();
  const { deployment } = manifest;
  yield* Console.log(
    `Target url=${deployment.url} profile=${deployment.profile} stage=${deployment.stage}`,
  );
  const runtime = yield* Runtime;
  const healthy = yield* runtime.health(deployment.url);
  yield* Console.log(`Worker health: ${healthy ? "ok" : "unhealthy"}`);
  let unhealthy = !healthy;
  for (const repo of manifest.repos) {
    const label = `${repo.owner}/${repo.repository}`;
    const configured = expectedHookUrl(deployment.url, repo.owner, repo.repository);
    yield* Console.log(`Webhook ${label} configured=${configured}`);
    const hooks = yield* fetchRepoHooks(repo.owner, repo.repository);
    if (hooks.failed) {
      yield* Console.log(`Webhook ${label} active=unknown (check token repo hook admin access)`);
      unhealthy = true;
      continue;
    }
    const hook = findActiveHook(hooks.pages!, deployment.url, repo.owner, repo.repository);
    if (hook === undefined) {
      yield* Console.log(`Webhook ${label} active=missing`);
      unhealthy = true;
    } else {
      yield* Console.log(`Webhook ${label} active=${hook.config.url}`);
    }
  }
  if (unhealthy) {
    return yield* Effect.fail(
      new CliError({ message: "Status unhealthy; fix Worker health or webhooks before deploying" }),
    );
  }
});

const GhUser = Schema.Struct({ login: Schema.String });
const RepoMeta = Schema.Struct({
  permissions: Schema.optionalKey(
    Schema.Struct({
      push: Schema.optionalKey(Schema.Boolean),
      admin: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  owner: Schema.Struct({
    login: Schema.String,
    type: Schema.String,
  }),
});
const CommentResponse = Schema.Struct({ html_url: Schema.String });

const authorizeRequest = Effect.fn("Commands.authorizeRequest")(function*(
  owner: string,
  repository: string,
  login: string,
) {
  if (login.toLowerCase() === owner.toLowerCase()) {
    return;
  }
  const json = yield* ghApiJson(`repos/${owner}/${repository}`);
  const repo = yield* Schema.decodeUnknownEffect(RepoMeta)(json).pipe(
    Effect.mapError(() => new CliError({ message: "Unexpected repository metadata from GitHub" })),
  );
  if (repo.permissions?.push === true || repo.permissions?.admin === true) {
    return;
  }
  if (repo.owner.type === "Organization") {
    const member = yield* ghApiJson(`orgs/${owner}/members/${login}`).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
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
});

const ReviewPage = Schema.Array(Schema.Struct({ body: Schema.NullOr(Schema.String) }));
const ReviewPages = Schema.Array(ReviewPage);

export const requestCommand = Effect.fn("Commands.request")(function*(pullInput: string) {
  const manifest = yield* loadManifest();
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
  const hooks = yield* fetchRepoHooks(owner, repository);
  if (hooks.failed) {
    return yield* Effect.fail(
      new CliError({
        message: `Cannot verify webhook for ${owner}/${repository}; check GitHub token access`,
      }),
    );
  }
  if (
    findActiveHook(hooks.pages!, manifest.deployment.url, owner, repository) === undefined
  ) {
    return yield* Effect.fail(
      new CliError({
        message:
          `No active enrollment webhook for ${owner}/${repository}; deploy with reviewer repos add --deploy`,
      }),
    );
  }
  const userJson = yield* ghApiJson("user");
  const user = yield* Schema.decodeUnknownEffect(GhUser)(userJson).pipe(
    Effect.mapError(() => new CliError({ message: "Unexpected user response from GitHub" })),
  );
  yield* authorizeRequest(owner, repository, user.login);
  const prJson = yield* ghApiJson(`repos/${owner}/${repository}/pulls/${pull.number}`);
  const pr = yield* Schema.decodeUnknownEffect(CliPull)(prJson).pipe(
    Effect.mapError(() =>
      new CliError({ message: "Unexpected pull request response from GitHub" })
    ),
  );
  if (pr.state !== "open") {
    yield* Console.log(`Skipped closed pull request #${pull.number}`);
    return;
  }
  if (pr.draft === true) {
    yield* Console.log(`Skipped draft pull request #${pull.number}`);
    return;
  }
  const headSha = pr.head.sha;
  const reviewsJson = yield* ghApiJson(
    `repos/${owner}/${repository}/pulls/${pull.number}/reviews`,
    {
      paginate: true,
    },
  );
  const reviewPages = yield* Schema.decodeUnknownEffect(ReviewPages)(reviewsJson).pipe(
    Effect.mapError(() => new CliError({ message: "Unexpected reviews response from GitHub" })),
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
  const latestJson = yield* ghApiJson(`repos/${owner}/${repository}/pulls/${pull.number}`);
  const latest = yield* Schema.decodeUnknownEffect(CliPull)(latestJson).pipe(
    Effect.mapError(() =>
      new CliError({ message: "Unexpected pull request response from GitHub" })
    ),
  );
  if (latest.head.sha !== headSha) {
    yield* Console.log(
      `Head moved to ${latest.head.sha.slice(0, 7)} during checks; submitting for latest head`,
    );
  }
  const token = yield* githubToken;
  const runtime = yield* Runtime;
  const responseJson = yield* runtime
    .run(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        `repos/${owner}/${repository}/issues/${pull.number}/comments`,
        "--method",
        "POST",
        "--field",
        "body=/review",
      ],
      { env: ghEnv(token) },
    )
    .pipe(
      Effect.catch(() =>
        Effect.fail(
          new CliError({
            message:
              "Failed to submit review request; GitHub may have accepted the comment before a transport error",
          }),
        )
      ),
    );
  const comment = yield* Schema.decodeUnknownEffect(CommentResponse)(JSON.parse(responseJson)).pipe(
    Effect.mapError(() => new CliError({ message: "Unexpected comment response from GitHub" })),
  );
  yield* Console.log(`Request submitted: ${comment.html_url}`);
});

const deployFlag = Flag.Boolean("deploy").pipe(
  Flag.withDescription("Deploy after updating reviewer.json"),
  Flag.withDefault(false),
);

const repos = Command.make("repos").pipe(Command.withDescription("Manage enrolled repositories"));

const reposListCmd = Command.make("list", {}, () => reposList()).pipe(
  Command.withDescription("List enrolled repositories"),
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
