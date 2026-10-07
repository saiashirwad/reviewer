import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import {
  CliError,
  githubToken,
  layer,
  loadEnvironment,
  opencodeKey,
  Runtime,
} from "../scripts/management/Runtime.ts";

const runtimeModuleUrl = fileURLToPath(
  new URL("../scripts/management/Runtime.ts", import.meta.url),
);

afterEach(() => {
  vi.restoreAllMocks();
});

it.effect("loadEnvironment ignores a missing env file", () =>
  loadEnvironment("/definitely/missing/management.env"));

it.effect("loadEnvironment surfaces non-ENOENT load failures", () => {
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  return loadEnvironment().pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toBe("Failed to load environment file");
    }),
  );
});

it.effect("loadEnvironment ignores ENOENT when code is non-enumerable", () => {
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
    const error = new Error("missing env file");
    Object.defineProperty(error, "code", { value: "ENOENT", enumerable: false });
    throw error;
  });
  return loadEnvironment();
});

it.live("loadEnvironment keeps shell env over dotenv file", () =>
  Effect.gen(function*() {
    const dir = yield* Effect.tryPromise(() => mkdtemp(join(tmpdir(), "mgmt-env-")));
    const envFile = join(dir, ".env");
    yield* Effect.tryPromise(() => writeFile(envFile, "MGMT_SHELL_PRECEDENCE=from-dotenv\n"));

    const output = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const child = spawnNodeChild(
            `import { loadEnvironment } from ${JSON.stringify(runtimeModuleUrl)};
             import { Effect } from "effect";
             await Effect.runPromise(loadEnvironment(${JSON.stringify(envFile)}));
             process.stdout.write(process.env.MGMT_SHELL_PRECEDENCE ?? "");`,
            { MGMT_SHELL_PRECEDENCE: "from-shell" },
            resolve,
            reject,
          );
          child.on("error", reject);
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("loadEnvironment subprocess failed", { cause }),
    }).pipe(Effect.orDie);

    expect(output).toBe("from-shell");
    yield* Effect.tryPromise(() => rm(dir, { recursive: true, force: true }));
  }));

it.live("Runtime.run captures stdout from a child process", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const output = yield* runtime.run(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(output).toBe("ok");
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run applies env overrides to the child process", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const output = yield* runtime.run(process.execPath, [
      "-e",
      "process.stdout.write(process.env.MGMT_PROBE ?? '')",
    ], {
      env: { MGMT_PROBE: "probe-value" },
    });
    expect(output).toBe("probe-value");
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run fails generically on nonzero exit", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const error = yield* runtime.run(process.execPath, ["-e", "process.exit(2)"]).pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run fails when the executable is missing", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const error = yield* runtime.run("definitely-not-a-command-mgmt", []).pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run fails when stdout exceeds the capture limit", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const script = [
      "process.on('SIGTERM', () => process.exit(0));",
      "const chunk = 'x'.repeat(65536);",
      "for (let i = 0; i < 20; i++) process.stdout.write(chunk);",
    ].join("");
    const error = yield* runtime.run(process.execPath, ["-e", script]).pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run interruption cancels a long-running child", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const marker = join(tmpdir(), `mgmt-ready-${crypto.randomUUID()}`);
    const script = `const fs=require('node:fs');fs.writeFileSync(${
      JSON.stringify(marker)
    },'ready');setInterval(()=>{},1e9);`;

    const fiber = yield* runtime.run(process.execPath, ["-e", script]).pipe(Effect.forkScoped);

    yield* waitForPath(marker);

    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);

    yield* Effect.tryPromise(() => rm(marker, { force: true }));
  }).pipe(Effect.provide(layer), Effect.scoped));

it.effect("Runtime.health checks origin root body", () => {
  const fetch: typeof globalThis.fetch = (input) => {
    const url = input instanceof Request ? input.url : new URL(input).href;
    expect(url).toBe("https://reviewer.example/");
    return Promise.resolve(new Response("reviewer\n", { status: 200 }));
  };

  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    expect(yield* runtime.health("https://reviewer.example/path")).toBe(true);
  }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

it.effect("Runtime.health returns false when the body does not match", () => {
  const fetch: typeof globalThis.fetch = () =>
    Promise.resolve(new Response("other", { status: 200 }));

  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    expect(yield* runtime.health("https://reviewer.example")).toBe(false);
  }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
});

it.effect("githubToken reads GITHUB_TOKEN from config", () =>
  Effect.gen(function*() {
    const token = yield* githubToken;
    expect(Redacted.value(token)).toBe("cfg-token");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.die("gh should not run"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "cfg-token" })),
      ),
    ),
  ));

it.effect("githubToken falls back to gh auth token output", () =>
  Effect.gen(function*() {
    const token = yield* githubToken;
    expect(Redacted.value(token)).toBe("gh-token");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: (command, args) => {
            expect(command).toBe("gh");
            expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
            return Effect.succeed("gh-token\n");
          },
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    ),
  ));

it.effect("githubToken maps gh spawn failures to a login hint", () =>
  Effect.gen(function*() {
    const error = yield* githubToken.pipe(Effect.flip);
    expect(error.message).toBe(
      "GitHub login unavailable; run gh auth login --hostname github.com or set GITHUB_TOKEN",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.fail(new CliError({ message: "Command failed" })),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    ),
  ));

it.effect("githubToken rejects empty configured tokens", () =>
  Effect.gen(function*() {
    const error = yield* githubToken.pipe(Effect.flip);
    expect(error.message).toBe("GITHUB_TOKEN is set but empty");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.die("gh should not run"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "   " })),
      ),
    ),
  ));

it.effect("githubToken preserves padded configured values without calling gh", () =>
  Effect.gen(function*() {
    const token = yield* githubToken;
    expect(Redacted.value(token)).toBe("  cfg-token  ");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.die("gh should not run"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "  cfg-token  " })),
      ),
    ),
  ));

it.effect("githubToken treats blank GITHUB_TOKEN as missing and uses gh", () =>
  Effect.gen(function*() {
    const token = yield* githubToken;
    expect(Redacted.value(token)).toBe("gh-token");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: (command, args) => {
            expect(command).toBe("gh");
            expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
            return Effect.succeed("gh-token\n");
          },
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "" })),
      ),
    ),
  ));

it.effect("githubToken trims gh stdout before validating", () =>
  Effect.gen(function*() {
    const token = yield* githubToken;
    expect(Redacted.value(token)).toBe("gh-token");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.succeed("  gh-token  \n"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    ),
  ));

it.effect("githubToken rejects blank gh stdout", () =>
  Effect.gen(function*() {
    const error = yield* githubToken.pipe(Effect.flip);
    expect(error.message).toBe(
      "GitHub token missing; set GITHUB_TOKEN or run gh auth login",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.succeed("   \n"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    ),
  ));

it.effect("githubToken whitespace errors avoid raw schema diagnostics", () =>
  Effect.gen(function*() {
    const error = yield* githubToken.pipe(Effect.flip);
    expect(error.message).toBe("GITHUB_TOKEN is set but empty");
    expect(error.message).not.toMatch(/ConfigError|SchemaError|Expected/);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => Effect.die("gh should not run"),
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "     " })),
      ),
    ),
  ));

it.effect("githubToken whitespace-only env does not fall back to gh", () => {
  let ghCalled = false;
  return Effect.gen(function*() {
    const error = yield* githubToken.pipe(Effect.flip);
    expect(ghCalled).toBe(false);
    expect(error.message).toBe("GITHUB_TOKEN is set but empty");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Runtime, {
          run: () => {
            ghCalled = true;
            return Effect.succeed("gh-token");
          },
          health: () => Effect.succeed(false),
        }),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "   " })),
      ),
    ),
  );
});

it.effect("opencodeKey reads OPENCODE_API_KEY from config", () =>
  Effect.gen(function*() {
    const key = yield* opencodeKey;
    expect(Redacted.value(key)).toBe("oc-key");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_API_KEY: "oc-key" })),
    ),
  ));

it.effect("opencodeKey fails with a useful hint when missing", () =>
  Effect.gen(function*() {
    const error = yield* opencodeKey.pipe(Effect.flip);
    expect(error.message).toContain(".env OPENCODE_API_KEY");
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))));

it.effect("opencodeKey preserves padded configured values", () =>
  Effect.gen(function*() {
    const key = yield* opencodeKey;
    expect(Redacted.value(key)).toBe("  oc-key  ");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_API_KEY: "  oc-key  " })),
    ),
  ));

it.effect("opencodeKey rejects whitespace-only values without echoing them", () =>
  Effect.gen(function*() {
    const error = yield* opencodeKey.pipe(Effect.flip);
    expect(error.message).toBe(
      "OPENCODE_API_KEY is set but empty; check your .env OPENCODE_API_KEY",
    );
    expect(error.message).not.toMatch(/SchemaError|Expected/);
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_API_KEY: "     " })),
    ),
  ));

const waitForPath = (path: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(interval);
        resume(Effect.void);
      }
    }, 10);
    return Effect.sync(() => {
      clearInterval(interval);
    });
  });

function spawnNodeChild(
  body: string,
  envOverrides: Record<string, string>,
  resolve: (value: string) => void,
  reject: (reason: unknown) => void,
) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", body],
    {
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  child.once("close", (code) => {
    if (code === 0) {
      resolve(stdout);
      return;
    }
    reject(new Error(`child exited with code ${String(code)}`));
  });
  return child;
}
