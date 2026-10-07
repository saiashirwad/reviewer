import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployManifest,
  expectedHookUrl,
  loadManifest,
  reposAdd,
  requestCommand,
} from "../scripts/management/Commands.ts";
import { CliError, Runtime } from "../scripts/management/Runtime.ts";

const sampleManifest = {
  model: "muse-spark-1.3-contributor",
  repos: [{ owner: "example", repository: "repo", guidance: "keep" }],
  deployment: { profile: "admin", stage: "prod", url: "https://example.workers.dev/" },
};

const withCwd = <E, R>(body: (cwd: string) => Effect.Effect<void, E, R>) =>
  Effect.gen(function*() {
    const cwd = yield* Effect.tryPromise(() => mkdtemp(join(tmpdir(), "reviewer-cmd-")));
    yield* body(cwd).pipe(
      Effect.ensuring(
        Effect.tryPromise(() => rm(cwd, { recursive: true, force: true })).pipe(Effect.ignore),
      ),
    );
  });

const writeManifest = (cwd: string) =>
  Effect.tryPromise(() =>
    writeFile(join(cwd, "reviewer.json"), JSON.stringify(sampleManifest, null, 2) + "\n")
  );

const runtimeLayer = (
  run: (command: string, args: ReadonlyArray<string>, options?: {
    env?: Readonly<Record<string, string | undefined>>;
    inherit?: boolean;
  }) => Effect.Effect<string, CliError>,
) =>
  Layer.succeed(Runtime, {
    run,
    health: () => Effect.succeed(true),
  });

const baseLayers = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(Runtime, {
    run: () => Effect.die("runtime not expected"),
    health: () => Effect.succeed(true),
  }),
);

it.effect("repos add preserves overrides and is idempotent", () =>
  withCwd((cwd) =>
    Effect.gen(function*() {
      yield* writeManifest(cwd);
      const previous = process.cwd();
      process.chdir(cwd);
      yield* reposAdd("example/other", false);
      yield* reposAdd("Example/Repo", false);
      const manifest = yield* loadManifest();
      process.chdir(previous);
      expect(manifest.repos).toEqual([
        { owner: "example", repository: "repo", guidance: "keep" },
        { owner: "example", repository: "other" },
      ]);
    })
  ).pipe(Effect.provide(baseLayers)));

it.effect("deploy passes pinned alchemy args without secrets in argv", () =>
  withCwd((cwd) =>
    Effect.gen(function*() {
      yield* writeManifest(cwd);
      const previous = process.cwd();
      process.chdir(cwd);
      let captured:
        | { command: string; args: ReadonlyArray<string>; env?: Record<string, string>; }
        | undefined;
      yield* deployManifest().pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayers,
            runtimeLayer((command, args, options) => {
              captured = { command, args, env: options?.env as Record<string, string> };
              return Effect.succeed("");
            }),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                GITHUB_TOKEN: "gh-secret",
                OPENCODE_API_KEY: "oc-secret",
              }),
            ),
          ),
        ),
      );
      process.chdir(previous);
      expect(captured?.command).toBe("pnpm");
      expect(captured?.args).toEqual([
        "exec",
        "alchemy",
        "deploy",
        "--profile",
        "admin",
        "--stage",
        "prod",
        "--yes",
      ]);
      expect(captured?.args).not.toContain("gh-secret");
      expect(captured?.env).toEqual({ GITHUB_TOKEN: "gh-secret", OPENCODE_API_KEY: "oc-secret" });
    }).pipe(Effect.provide(baseLayers))
  ));

it.effect("deploy failure leaves reviewer.json intact", () =>
  withCwd((cwd) =>
    Effect.gen(function*() {
      yield* writeManifest(cwd);
      const before = yield* Effect.tryPromise(() => readFile(join(cwd, "reviewer.json"), "utf8"));
      const previous = process.cwd();
      process.chdir(cwd);
      const error = yield* deployManifest().pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayers,
            runtimeLayer(() => Effect.fail(new CliError({ message: "Command failed" }))),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                GITHUB_TOKEN: "gh-secret",
                OPENCODE_API_KEY: "oc-secret",
              }),
            ),
          ),
        ),
        Effect.flip,
      );
      const after = yield* Effect.tryPromise(() => readFile(join(cwd, "reviewer.json"), "utf8"));
      process.chdir(previous);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("Deploy failed");
      expect(after).toBe(before);
    }).pipe(Effect.provide(baseLayers))
  ));

it.effect("request skips closed pulls and duplicate markers across pages", () =>
  Effect.gen(function*() {
    const calls: Array<ReadonlyArray<string>> = [];
    const runtime = runtimeLayer((command, args) => {
      calls.push(args);
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (endpoint.endsWith("/hooks")) {
        return Effect.succeed(
          JSON.stringify([[
            {
              active: true,
              events: ["pull_request", "issue_comment"],
              config: { url: expectedHookUrl(sampleManifest.deployment.url, "example", "repo") },
            },
          ]]),
        );
      }
      if (endpoint.includes("/reviews")) {
        return Effect.succeed(
          JSON.stringify([[{ body: "other" }], [{ body: "<!-- reviewer:abc123 -->" }]]),
        );
      }
      if (endpoint.includes("/pulls/")) {
        return Effect.succeed(
          JSON.stringify({
            state: "open",
            draft: false,
            head: { sha: "abc123" },
            base: { sha: "base", ref: "main" },
          }),
        );
      }
      if (args.includes("user")) {
        return Effect.succeed(JSON.stringify({ login: "example" }));
      }
      if (endpoint === "repos/example/repo") {
        return Effect.succeed(
          JSON.stringify({
            permissions: { push: true },
            owner: { login: "example", type: "User" },
          }),
        );
      }
      return Effect.fail(new CliError({ message: "unexpected gh call" }));
    });
    yield* withCwd((cwd) =>
      Effect.gen(function*() {
        yield* writeManifest(cwd);
        const previous = process.cwd();
        process.chdir(cwd);
        yield* requestCommand("example/repo#1").pipe(
          Effect.provide(
            Layer.mergeAll(
              baseLayers,
              runtime,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "t" })),
            ),
          ),
        );
        process.chdir(previous);
      }).pipe(Effect.provide(baseLayers))
    );
    expect(calls.some((args) => args.includes("POST"))).toBe(false);
    expect(calls.some((args) => args.some((part) => part.includes("/reviews")))).toBe(true);
  }));

it.effect("request posts /review with matching tokens", () =>
  Effect.gen(function*() {
    const calls: Array<{ args: ReadonlyArray<string>; env: Record<string, string> | undefined; }> =
      [];
    const runtime = runtimeLayer((command, args, options) => {
      const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (endpoint.endsWith("/hooks")) {
        return Effect.succeed(
          JSON.stringify([[
            {
              active: true,
              events: ["*"],
              config: { url: expectedHookUrl(sampleManifest.deployment.url, "example", "repo") },
            },
          ]]),
        );
      }
      if (endpoint.includes("/reviews")) {
        return Effect.succeed(JSON.stringify([[{ body: "fresh" }]]));
      }
      if (endpoint.includes("/pulls/")) {
        return Effect.succeed(
          JSON.stringify({
            state: "open",
            draft: false,
            head: { sha: "deadbeef" },
            base: { sha: "base", ref: "main" },
          }),
        );
      }
      if (args.includes("user")) {
        return Effect.succeed(JSON.stringify({ login: "example" }));
      }
      if (args.includes("POST")) {
        calls.push({ args, env: options?.env as Record<string, string> });
        return Effect.succeed(
          JSON.stringify({ html_url: "https://github.com/example/repo/issues/1#issuecomment-1" }),
        );
      }
      return Effect.fail(new CliError({ message: `unexpected ${args.join(" ")}` }));
    });
    yield* withCwd((cwd) =>
      Effect.gen(function*() {
        yield* writeManifest(cwd);
        const previous = process.cwd();
        process.chdir(cwd);
        yield* requestCommand("https://github.com/example/repo/pull/1").pipe(
          Effect.provide(
            Layer.mergeAll(
              baseLayers,
              runtime,
              ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "same-token" })),
            ),
          ),
        );
        process.chdir(previous);
      }).pipe(Effect.provide(baseLayers))
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--field");
    expect(calls[0]?.args).toContain("body=/review");
    expect(calls[0]?.env?.GH_TOKEN).toBe("same-token");
    expect(calls[0]?.env?.GITHUB_TOKEN).toBe("same-token");
  }));
