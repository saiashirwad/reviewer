import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { spawn } from "node:child_process";

const STDOUT_MAX_BYTES = 1_048_576;
const HEALTH_TIMEOUT_MS = 5_000;

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
}) {}

const commandFailed = new CliError({ message: "Command failed" });

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const mergeEnv = (
  base: NodeJS.ProcessEnv,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv => {
  if (overrides === undefined) {
    return { ...base };
  }
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const spawnCommand = Effect.fn("Runtime.run")(function*(
  command: string,
  args: ReadonlyArray<string>,
  options?: {
    env?: Readonly<Record<string, string | undefined>>;
    inherit?: boolean;
  },
) {
  const inherit = options?.inherit === true;
  const env = mergeEnv(process.env, options?.env);

  return yield* Effect.scoped(
    Effect.gen(function*() {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(command, [...args], {
            env,
            shell: false,
            stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
          })
        ),
        (proc) =>
          Effect.sync(() => {
            if (!proc.killed && proc.exitCode === null) {
              proc.kill();
            }
          }),
      );

      const result = yield* Effect.callback<string, CliError>((resume) => {
        let stdout = "";
        let stdoutBytes = 0;
        let settled = false;

        const finish = (effect: Effect.Effect<string, CliError>) => {
          if (settled) {
            return;
          }
          settled = true;
          resume(effect);
        };

        child.once("error", () => {
          finish(Effect.fail(commandFailed));
        });

        child.once("close", (code) => {
          if (code === 0) {
            finish(Effect.succeed(stdout));
            return;
          }
          finish(Effect.fail(commandFailed));
        });

        if (!inherit && child.stdout !== null) {
          child.stdout.on("data", (chunk: Buffer | string) => {
            const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            stdoutBytes += Buffer.byteLength(piece, "utf8");
            if (stdoutBytes > STDOUT_MAX_BYTES) {
              child.kill();
              return;
            }
            stdout += piece;
          });
        }

        if (!inherit && child.stderr !== null) {
          child.stderr.on("data", () => {
            // stderr is captured but never surfaced in errors
          });
        }

        return Effect.sync(() => {
          if (!settled && child.exitCode === null) {
            child.kill();
          }
        });
      });

      return result;
    }),
  );
});

const checkHealth = Effect.fn("Runtime.health")(function*(url: string) {
  const target = `${new URL(url).origin}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, HEALTH_TIMEOUT_MS);

  return yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(target, { signal: controller.signal });
      if (!response.ok) {
        return false;
      }
      const body = (await response.text()).trim();
      return body === "reviewer";
    },
    catch: () => commandFailed,
  }).pipe(
    Effect.ensuring(Effect.sync(() => {
      clearTimeout(timeout);
    })),
  );
});

export interface RuntimeInterface {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      env?: Readonly<Record<string, string | undefined>>;
      inherit?: boolean;
    },
  ) => Effect.Effect<string, CliError>;
  readonly health: (url: string) => Effect.Effect<boolean, CliError>;
}

export class Runtime extends Context.Service<Runtime, RuntimeInterface>()(
  "@reviewer/management/Runtime",
) {}

export const layer = Layer.succeed(Runtime, {
  run: spawnCommand,
  health: checkHealth,
});

export const loadEnvironment = (
  path?: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(Effect.sync(() => process.loadEnvFile(path)));
    if (!Exit.isFailure(exit)) {
      return;
    }
    const cause = Cause.squash(exit.cause);
    if (isEnoent(cause)) {
      return;
    }
    return yield* Effect.fail(new CliError({ message: "Failed to load environment file" }));
  });

const nonEmptyRedacted = (
  value: Redacted.Redacted<string>,
  message: string,
): Effect.Effect<Redacted.Redacted<string>, CliError> => {
  if (Redacted.value(value).trim().length === 0) {
    return Effect.fail(new CliError({ message }));
  }
  return Effect.succeed(value);
};

export const githubToken: Effect.Effect<Redacted.Redacted<string>, CliError, Runtime> = Effect.gen(
  function*() {
    const configured = yield* Config.option(Config.Redacted("GITHUB_TOKEN")).pipe(
      Effect.mapError(
        () => new CliError({ message: "Invalid GITHUB_TOKEN configuration" }),
      ),
    );
    if (Option.isSome(configured)) {
      return yield* nonEmptyRedacted(
        configured.value,
        "GITHUB_TOKEN is set but empty",
      );
    }

    const runtime = yield* Runtime;
    const token = yield* runtime.run("gh", ["auth", "token", "--hostname", "github.com"]).pipe(
      Effect.map((output) => output.trim()),
    );
    if (token.length === 0) {
      return yield* Effect.fail(
        new CliError({ message: "GitHub token missing; set GITHUB_TOKEN or run gh auth login" }),
      );
    }
    return Redacted.make(token);
  },
);

export const opencodeKey: Effect.Effect<Redacted.Redacted<string>, CliError> = Config.Redacted(
  "OPENCODE_API_KEY",
).pipe(
  Effect.mapError(
    () =>
      new CliError({ message: "OPENCODE_API_KEY missing; set .env OPENCODE_API_KEY or export it" }),
  ),
  Effect.flatMap((key) =>
    nonEmptyRedacted(key, "OPENCODE_API_KEY is set but empty; check your .env OPENCODE_API_KEY")
  ),
);

export const configFromEnv = ConfigProvider.layer(ConfigProvider.fromEnv());
