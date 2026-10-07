import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployCommand,
  expectedHookUrl,
  loadManifest,
  reposAdd,
  requestCommand,
  statusCommand,
} from "../scripts/management/Commands.ts";
import { CliError, Runtime } from "../scripts/management/Runtime.ts";

const sampleManifest = {
  model: "muse-spark-1.3-contributor",
  repos: [{ owner: "example", repository: "repo", guidance: "keep" }],
  deployment: { profile: "admin", stage: "prod", url: "https://example.workers.dev/" },
};

type RunOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  inherit?: boolean;
};

const withDir = <E, R>(body: (dir: string) => Effect.Effect<void, E, R>) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "reviewer-cmd-"))),
    (dir) => Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  ).pipe(Effect.flatMap(body));

const writeManifest = (dir: string) =>
  Effect.tryPromise(() =>
    writeFile(join(dir, "reviewer.json"), JSON.stringify(sampleManifest, null, 2) + "\n")
  );

const runtimeLayer = (
  run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: RunOptions,
  ) => Effect.Effect<string, CliError>,
  health: (url: string) => Effect.Effect<boolean, CliError> = () => Effect.succeed(true),
) => Layer.succeed(Runtime, { run, health });

const baseLayers = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(Runtime, {
    run: () => Effect.die("runtime not expected"),
    health: () => Effect.succeed(true),
  }),
);

const tokenLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_TOKEN: "test-token" }));

const ghMock = (
  handler: (args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<string, CliError>,
  health: (url: string) => Effect.Effect<boolean, CliError> = () => Effect.succeed(true),
) =>
  Layer.mergeAll(
    baseLayers,
    runtimeLayer((_command, args, options) => handler(args, options), health),
    tokenLayer,
  );

const hookPage = (extra?: { url?: string; events?: ReadonlyArray<string>; }) =>
  JSON.stringify([[
    {
      active: true,
      events: extra?.events ?? ["pull_request", "issue_comment"],
      config: {
        url: extra?.url ?? expectedHookUrl(sampleManifest.deployment.url, "example", "repo"),
      },
    },
    { active: true, events: ["push"], config: {} },
  ]]);

it.effect("repos add preserves overrides and is idempotent", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      yield* reposAdd("example/other", false, { baseDir: dir });
      yield* reposAdd("Example/Repo", false, { baseDir: dir });
      const manifest = yield* loadManifest({ baseDir: dir });
      expect(manifest.repos).toEqual([
        { owner: "example", repository: "repo", guidance: "keep" },
        { owner: "example", repository: "other" },
      ]);
    }).pipe(Effect.provide(baseLayers))
  ));

it.effect("deploy passes pinned alchemy args without secrets in argv", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      let captured:
        | { command: string; args: ReadonlyArray<string>; env?: RunOptions["env"]; }
        | undefined;
      yield* deployCommand({ baseDir: dir }).pipe(
        Effect.provide(
          Layer.mergeAll(
            baseLayers,
            runtimeLayer((command, args, options) => {
              captured = { command, args, env: options?.env };
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
      expect(captured?.env).toEqual({ GITHUB_TOKEN: "gh-secret", OPENCODE_API_KEY: "oc-secret" });
    })
  ));

it.effect("deploy failure leaves reviewer.json intact", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      const before = yield* Effect.tryPromise(() => readFile(join(dir, "reviewer.json"), "utf8"));
      const error = yield* deployCommand({ baseDir: dir }).pipe(
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
      const after = yield* Effect.tryPromise(() => readFile(join(dir, "reviewer.json"), "utf8"));
      expect(error).toBeInstanceOf(CliError);
      if (error instanceof CliError) {
        expect(error.message).toContain("Deploy failed");
      }
      expect(after).toBe(before);
    })
  ));

it.effect("manifest lock conflicts and releases after success", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      const lock = yield* Effect.tryPromise(() => open(join(dir, "reviewer.json.lock"), "wx"));
      const conflict = yield* reposAdd("example/new", false, { baseDir: dir }).pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(CliError);
      if (conflict instanceof CliError) {
        expect(conflict.message).toContain("reviewer.json.lock");
      }
      yield* Effect.tryPromise(() => lock.close());
      yield* Effect.tryPromise(() => rm(join(dir, "reviewer.json.lock")));
      yield* reposAdd("example/new", false, { baseDir: dir });
      const manifest = yield* loadManifest({ baseDir: dir });
      expect(manifest.repos).toHaveLength(2);
      const released = yield* Effect.tryPromise({
        try: () => open(join(dir, "reviewer.json.lock"), "wx"),
        catch: () => undefined,
      });
      expect(released).toBeDefined();
      if (released !== undefined) {
        yield* Effect.tryPromise(() => released.close());
        yield* Effect.tryPromise(() => rm(join(dir, "reviewer.json.lock")));
      }
    }).pipe(Effect.provide(baseLayers))
  ));

it.effect("add and deploy hold the lock together and preserve edits after deployment failure", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      const failure = yield* reposAdd("example/new", true, { baseDir: dir }).pipe(
        Effect.provide(Layer.mergeAll(
          NodeServices.layer,
          runtimeLayer(() =>
            Effect.gen(function*() {
              const conflict = yield* reposAdd("example/interference", false, { baseDir: dir })
                .pipe(Effect.match({
                  onFailure: (error) => error.message,
                  onSuccess: () => "unexpected lock success",
                }));
              expect(conflict).toContain("reviewer.json.lock");
              return yield* new CliError({ message: "simulated deployment failure" });
            }).pipe(Effect.provide(baseLayers))
          ),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              GITHUB_TOKEN: "test-token",
              OPENCODE_API_KEY: "test-key",
            }),
          ),
        )),
        Effect.flip,
      );
      expect(failure.message).toContain("Deploy failed");
      const manifest = yield* loadManifest({ baseDir: dir });
      expect(manifest.repos.map((repo) => repo.repository)).toEqual(["repo", "new"]);
      yield* reposAdd("example/after-failure", false, { baseDir: dir });
      expect((yield* loadManifest({ baseDir: dir })).repos).toHaveLength(3);
    }).pipe(Effect.provide(baseLayers))
  ));

it.effect("request skips duplicate markers and closed pulls", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      const calls: Array<ReadonlyArray<string>> = [];
      let prState = "open";
      yield* requestCommand("example/repo#1", { baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args) => {
            calls.push(args);
            const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(hookPage());
            }
            if (endpoint.includes("/reviews")) {
              return Effect.succeed(
                JSON.stringify([[{ body: "other" }], [{ body: "<!-- reviewer:abc123 -->" }]]),
              );
            }
            if (endpoint.includes("/pulls/")) {
              return Effect.succeed(
                JSON.stringify({ state: prState, draft: false, head: { sha: "abc123" } }),
              );
            }
            if (args.includes("user")) {
              return Effect.succeed(JSON.stringify({ login: "example" }));
            }
            return Effect.fail(new CliError({ message: "unexpected" }));
          }),
        ),
      );
      prState = "closed";
      yield* requestCommand("example/repo#1", { baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args) => {
            calls.push(args);
            const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(hookPage());
            }
            if (endpoint.includes("/reviews")) {
              return Effect.succeed(JSON.stringify([[{ body: "other" }]]));
            }
            if (endpoint.includes("/pulls/")) {
              return Effect.succeed(
                JSON.stringify({ state: prState, draft: false, head: { sha: "abc123" } }),
              );
            }
            if (args.includes("user")) {
              return Effect.succeed(JSON.stringify({ login: "example" }));
            }
            return Effect.fail(new CliError({ message: "unexpected" }));
          }),
        ),
      );
      expect(calls.some((args) => args.includes("POST"))).toBe(false);
    })
  ));

it.effect("request refuses moved head and malformed github json", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      let pullCalls = 0;
      const moved = yield* requestCommand("example/repo#1", { baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args) => {
            const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(hookPage());
            }
            if (endpoint.includes("/reviews")) {
              return Effect.succeed(JSON.stringify([[{ body: "fresh" }]]));
            }
            if (endpoint.includes("/pulls/")) {
              pullCalls += 1;
              const sha = pullCalls === 1 ? "aaaa" : "bbbb";
              return Effect.succeed(JSON.stringify({ state: "open", draft: false, head: { sha } }));
            }
            if (args.includes("user")) {
              return Effect.succeed(JSON.stringify({ login: "example" }));
            }
            return Effect.fail(new CliError({ message: "unexpected" }));
          }),
        ),
        Effect.flip,
      );
      expect(moved).toBeInstanceOf(CliError);
      if (moved instanceof CliError) {
        expect(moved.message).toContain("head changed");
      }
      const badJson = yield* requestCommand("example/repo#1", { baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args) => {
            if (args.some((arg) => arg.endsWith("/hooks"))) {
              return Effect.succeed(hookPage());
            }
            if (args.includes("user")) {
              return Effect.succeed(JSON.stringify({ login: "example" }));
            }
            return Effect.succeed("{");
          }),
        ),
        Effect.flip,
      );
      expect(badJson).toBeInstanceOf(CliError);
      if (badJson instanceof CliError) {
        expect(badJson.message).toBe("Unexpected response from GitHub");
      }
    })
  ));

it.effect("request posts /review with matching tokens and accepts org membership 204", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      let postEnv: RunOptions["env"] | undefined;
      yield* requestCommand("https://github.com/example/repo/pull/1", { baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args, options) => {
            const endpoint = args.find((arg) => arg.startsWith("repos/") || arg.startsWith("orgs/"))
              ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(hookPage({ events: ["*"] }));
            }
            if (endpoint.includes("/reviews")) {
              return Effect.succeed(JSON.stringify([[{ body: "fresh" }]]));
            }
            if (endpoint.includes("/pulls/")) {
              return Effect.succeed(
                JSON.stringify({ state: "open", draft: false, head: { sha: "deadbeef" } }),
              );
            }
            if (args.includes("user")) {
              return Effect.succeed(JSON.stringify({ login: "member" }));
            }
            if (endpoint === "repos/example/repo") {
              return Effect.succeed(
                JSON.stringify({
                  permissions: { push: false },
                  owner: { login: "example", type: "Organization" },
                }),
              );
            }
            if (endpoint.startsWith("orgs/example/members/")) {
              return Effect.succeed("");
            }
            if (args.includes("POST")) {
              postEnv = options?.env;
              return Effect.succeed(
                JSON.stringify({
                  html_url: "https://github.com/example/repo/issues/1#issuecomment-1",
                }),
              );
            }
            return Effect.fail(new CliError({ message: `unexpected ${args.join(" ")}` }));
          }),
        ),
      );
      expect(postEnv?.GH_TOKEN).toBe("test-token");
      expect(postEnv?.GITHUB_TOKEN).toBe("test-token");
    })
  ));

it.effect("status continues after unavailable health and ignores non-webhook hooks", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      let hooksChecked = false;
      const error = yield* statusCommand({ baseDir: dir }).pipe(
        Effect.provide(
          ghMock(
            (args) => {
              const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
              if (endpoint.endsWith("/hooks")) {
                hooksChecked = true;
                return Effect.succeed(hookPage({ url: "https://other.example/hook" }));
              }
              return Effect.fail(new CliError({ message: "unexpected" }));
            },
            () => Effect.fail(new CliError({ message: "Command failed" })),
          ),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(CliError);
      expect(hooksChecked).toBe(true);
      if (error instanceof CliError) {
        expect(error.message).toContain("Status checks failed");
      }
    })
  ));

it.effect("status reports missing webhook events", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      const error = yield* statusCommand({ baseDir: dir }).pipe(
        Effect.provide(
          ghMock((args) => {
            const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(
                hookPage({
                  events: ["pull_request"],
                  url: expectedHookUrl(sampleManifest.deployment.url, "example", "repo"),
                }),
              );
            }
            return Effect.fail(new CliError({ message: "unexpected" }));
          }),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(CliError);
    })
  ));

it.effect("request preflight refuses drafts, missing hooks, and PRs that close during checks", () =>
  withDir((dir) =>
    Effect.gen(function*() {
      yield* writeManifest(dir);
      for (
        const scenario of [
          "draft",
          "draft-after-check",
          "closed-after-check",
          "missing-hook",
          "missing-events",
        ]
      ) {
        let pullCalls = 0;
        let postCalls = 0;
        const outcome = yield* requestCommand("example/repo#1", { baseDir: dir }).pipe(
          Effect.provide(ghMock((args) => {
            if (args.includes("POST")) {
              postCalls += 1;
              return Effect.succeed(
                JSON.stringify({
                  html_url: "https://github.com/example/repo/pull/1#issuecomment-1",
                }),
              );
            }
            const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
            if (endpoint.endsWith("/hooks")) {
              return Effect.succeed(
                scenario === "missing-hook"
                  ? "[[]]"
                  : hookPage({ events: scenario === "missing-events" ? ["pull_request"] : ["*"] }),
              );
            }
            if (args.includes("user")) return Effect.succeed('{"login":"example"}');
            if (endpoint.includes("/reviews")) return Effect.succeed("[[]]");
            if (endpoint.includes("/pulls/")) {
              pullCalls += 1;
              return Effect.succeed(JSON.stringify({
                state: scenario === "closed-after-check" && pullCalls > 1 ? "closed" : "open",
                draft: scenario === "draft" || (scenario === "draft-after-check" && pullCalls > 1),
                head: { sha: "abc123" },
              }));
            }
            return Effect.die("Unexpected API call");
          })),
          Effect.match({ onSuccess: () => "skipped", onFailure: (error) => error.message }),
        );
        expect(postCalls).toBe(0);
        if (scenario.startsWith("missing")) {
          expect(outcome).toContain("No active enrollment webhook");
        } else expect(outcome).toBe("skipped");
      }
    })
  ));
