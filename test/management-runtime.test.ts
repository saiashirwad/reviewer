import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { afterEach, vi } from "vitest";
import {
  CliError,
  githubToken,
  layer,
  loadEnvironment,
  opencodeKey,
  Runtime,
} from "../scripts/management/Runtime.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

it.effect("loadEnvironment ignores a missing env file", () =>
  loadEnvironment("/definitely/missing/management.env"));

it.effect("loadEnvironment surfaces non-ENOENT load failures", () => {
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  });
  return loadEnvironment().pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toBe("Failed to load environment file");
    }),
  );
});

it.effect("loadEnvironment delegates to process.loadEnvFile", () => {
  const spy = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
  return loadEnvironment("custom.env").pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(spy).toHaveBeenCalledWith("custom.env");
      })
    ),
  );
});

it.live("Runtime.run captures stdout from a child process", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const output = yield* runtime.run(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(output).toBe("ok");
  }).pipe(Effect.provide(layer)));

it.live("Runtime.run fails generically on nonzero exit", () =>
  Effect.gen(function*() {
    const runtime = yield* Runtime;
    const error = yield* runtime.run(process.execPath, ["-e", "process.exit(2)"]).pipe(Effect.flip);
    expect(error).toEqual(new CliError({ message: "Command failed" }));
  }).pipe(Effect.provide(layer)));

it.effect("Runtime.health checks origin root body", () => {
  globalThis.fetch = (async (input) => {
    const url = input instanceof Request ? input.url : new URL(input).href;
    expect(url).toBe("https://reviewer.example/");
    return new Response("reviewer\n", { status: 200 });
  }) as typeof fetch;

  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    expect(yield* runtime.health("https://reviewer.example/path")).toBe(true);
  }).pipe(Effect.provide(layer));
});

it.effect("Runtime.health returns false when the body does not match", () => {
  globalThis.fetch = (async () => new Response("other", { status: 200 })) as typeof fetch;

  return Effect.gen(function*() {
    const runtime = yield* Runtime;
    expect(yield* runtime.health("https://reviewer.example")).toBe(false);
  }).pipe(Effect.provide(layer));
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
