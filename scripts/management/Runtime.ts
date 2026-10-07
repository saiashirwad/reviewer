import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { spawn } from "node:child_process";

const STDOUT_MAX_BYTES = 1_048_576;
const HEALTH_TIMEOUT_MS = 5_000;

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
}) {}

const commandFailed = new CliError({ message: "Command failed" });

const ghLoginUnavailable = new CliError({
  message: "GitHub login unavailable; run gh auth login --hostname github.com or set GITHUB_TOKEN",
});

const NodeEnoent = Schema.Struct({ code: Schema.Literal("ENOENT") });
const isEnoent = Schema.is(NodeEnoent);

const NonWhitespaceSecret = Schema.String.check(Schema.isPattern(/\S/));
const SecretRedacted = Schema.RedactedFromValue(NonWhitespaceSecret);

const githubTokenFromEnv = Config.schema(SecretRedacted, "GITHUB_TOKEN");
const opencodeKeyFromEnv = Config.schema(SecretRedacted, "OPENCODE_API_KEY");

const mapGithubTokenConfigError = (error: Config.ConfigError): CliError =>
  error.cause._tag === "SchemaError"
    ? new CliError({ message: "GITHUB_TOKEN is set but empty" })
    : new CliError({ message: "Invalid GITHUB_TOKEN configuration" });

const opencodeKeyMissing = new CliError({
  message: "OPENCODE_API_KEY missing; set .env OPENCODE_API_KEY or export it",
});

const opencodeKeyEmpty = new CliError({
  message: "OPENCODE_API_KEY is set but empty; check your .env OPENCODE_API_KEY",
});

const mapOpencodeKeyConfigError = (error: Config.ConfigError): CliError =>
  error.cause._tag === "SchemaError" ? opencodeKeyEmpty : opencodeKeyMissing;

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
              finish(Effect.fail(commandFailed));
              child.kill();
              return;
            }
            stdout += piece;
          });
        }

        if (!inherit && child.stderr !== null) {
          child.stderr.resume();
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

const makeCheckHealth = (client: HttpClient.HttpClient) =>
  Effect.fn("Runtime.health")(
    function*(url: string) {
      const response = yield* client.get(`${new URL(url).origin}/`);
      if (response.status < 200 || response.status >= 300) return false;
      const body = yield* response.text;
      return body.trim() === "reviewer";
    },
    Effect.timeout(HEALTH_TIMEOUT_MS),
    Effect.mapError(() => commandFailed),
  );

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

export const layer = Layer.effect(
  Runtime,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    return Runtime.of({ run: spawnCommand, health: makeCheckHealth(client) });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export const loadEnvironment = (
  path?: string,
): Effect.Effect<void, CliError> =>
  Effect.try({
    try: () => {
      process.loadEnvFile(path);
    },
    catch: (cause: unknown): CliError | "ENOENT" =>
      isEnoent(cause) ? "ENOENT" : new CliError({ message: "Failed to load environment file" }),
  }).pipe(
    Effect.catchIf((error) => error === "ENOENT", () => Effect.void),
  );

const decodeGhStdoutToken = (output: string) =>
  Schema.decodeUnknownEffect(SecretRedacted)(output.trim()).pipe(
    Effect.mapError(
      () =>
        new CliError({
          message: "GitHub token missing; set GITHUB_TOKEN or run gh auth login",
        }),
    ),
  );

export const githubToken: Effect.Effect<Redacted.Redacted<string>, CliError, Runtime> = Effect.gen(
  function*() {
    const configured = yield* Config.option(githubTokenFromEnv).pipe(
      Effect.mapError(mapGithubTokenConfigError),
    );
    if (Option.isSome(configured)) {
      return configured.value;
    }

    const runtime = yield* Runtime;
    const output = yield* runtime.run("gh", ["auth", "token", "--hostname", "github.com"]).pipe(
      Effect.mapError(() => ghLoginUnavailable),
    );
    return yield* decodeGhStdoutToken(output);
  },
);

export const opencodeKey: Effect.Effect<Redacted.Redacted<string>, CliError> = Effect.gen(
  function*() {
    const configured = yield* Config.option(opencodeKeyFromEnv).pipe(
      Effect.mapError(mapOpencodeKeyConfigError),
    );
    if (Option.isNone(configured)) {
      return yield* Effect.fail(opencodeKeyMissing);
    }
    return configured.value;
  },
);
