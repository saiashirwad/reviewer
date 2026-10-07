import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CliError } from "../scripts/management/Runtime.ts";
import * as ReviewArgs from "../scripts/ReviewArgs.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const nodeFlags = ["--experimental-strip-types"];
const sha = "a".repeat(40);
const scriptTimeoutMs = 10_000;

const cliOutput = (result: { stdout: string; stderr: string; }) => result.stdout + result.stderr;

const runScript = (script: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      execute(process.execPath, [...nodeFlags, script, ...args], {
        cwd: root,
        env: { ...process.env, GITHUB_TOKEN: "", OPENCODE_API_KEY: "" },
        timeout: scriptTimeoutMs,
      }).then(
        (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
        (error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number; }) => ({
          code: typeof error.code === "number" ? error.code : 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        }),
      ),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

it.effect("decodeReviewCommitArgv accepts shorthand, URL, and --post", () =>
  Effect.gen(function*() {
    const shorthand = yield* ReviewArgs.decodeReviewCommitArgv([
      "acme/widget#42",
      sha,
      sha,
    ]);
    expect(shorthand.ref).toEqual({ owner: "acme", repository: "widget", number: 42 });
    expect(shorthand.post).toBe(false);

    const safePr = yield* ReviewArgs.decodeReviewCommitArgv([
      "acme/widget#9007199254740991",
      sha,
      sha,
    ]);
    expect(safePr.ref.number).toBe(9007199254740991);

    const url = yield* ReviewArgs.decodeReviewCommitArgv([
      "https://github.com/acme/widget/pull/99",
      sha,
      sha,
      "--post",
    ]);
    expect(url.ref.number).toBe(99);
    expect(url.post).toBe(true);
  }));

it.effect("decodeReviewCommitArgv maps argv mistakes to CliError", () =>
  Effect.gen(function*() {
    for (
      const argv of [
        [],
        ["acme/widget#1", sha],
        ["acme/widget#1", sha, sha, "--post", "extra"],
        ["acme/widget#1", sha, "A".repeat(40)],
        ["acme/widget#1", "short", sha],
        ["acme/widget#1", sha, sha, "--publish"],
      ] as const
    ) {
      const error = yield* Effect.flip(ReviewArgs.decodeReviewCommitArgv(argv));
      expect(error).toEqual(new CliError({ message: ReviewArgs.reviewCommitUsage }));
    }

    const badTarget = yield* Effect.flip(ReviewArgs.decodeReviewCommitArgv([
      "acme/widget",
      sha,
      sha,
    ]));
    expect(badTarget).toEqual(new CliError({ message: ReviewArgs.reviewCommitUsage }));
  }));

it.effect("decodeDryRunArgv accepts optional model and rejects malformed argv", () =>
  Effect.gen(function*() {
    const withModel = yield* ReviewArgs.decodeDryRunArgv(["acme/widget#1", "custom-model"]);
    expect(withModel).toEqual({ target: "acme/widget#1", modelOverride: "custom-model" });

    const bare = yield* ReviewArgs.decodeDryRunArgv(["acme/widget#1"]);
    expect(bare).toEqual({ target: "acme/widget#1" });

    const url = yield* ReviewArgs.decodeDryRunArgv([
      "https://github.com/acme/widget/pull/9007199254740991",
    ]);
    expect(url.target).toContain("/pull/");

    for (const argv of [[], ["a", "b", "c"]] as const) {
      const error = yield* Effect.flip(ReviewArgs.decodeDryRunArgv(argv));
      expect(error).toEqual(new CliError({ message: ReviewArgs.dryRunUsage }));
    }
  }));

it.effect("dry-run CLI prints help and rejects bad argv without loading credentials", () =>
  Effect.gen(function*() {
    const help = yield* runScript("scripts/dry-run.ts", ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(ReviewArgs.dryRunUsage);

    const missing = yield* runScript("scripts/dry-run.ts", []);
    expect(missing.code).not.toBe(0);
    expect(cliOutput(missing)).toContain(ReviewArgs.dryRunUsage);
    expect(cliOutput(missing)).not.toMatch(/OPENCODE_API_KEY|GITHUB_TOKEN|Invalid configuration/i);

    const extra = yield* runScript("scripts/dry-run.ts", ["acme/widget#1", "model", "junk"]);
    expect(extra.code).not.toBe(0);
    expect(cliOutput(extra)).toContain(ReviewArgs.dryRunUsage);
    expect(cliOutput(extra)).not.toMatch(/OPENCODE_API_KEY|GITHUB_TOKEN|Invalid configuration/i);
  }));

it.effect("review-commit CLI rejects bad argv before review work", () =>
  Effect.gen(function*() {
    const missing = yield* runScript("scripts/review-commit.ts", []);
    expect(missing.code).not.toBe(0);
    expect(cliOutput(missing)).toContain(ReviewArgs.reviewCommitUsage);
    expect(cliOutput(missing)).not.toMatch(/OPENCODE_API_KEY|GITHUB_TOKEN|Invalid configuration/i);

    const badSha = yield* runScript("scripts/review-commit.ts", [
      "acme/widget#1",
      "not-a-sha",
      sha,
    ]);
    expect(badSha.code).not.toBe(0);
    expect(cliOutput(badSha)).toContain(ReviewArgs.reviewCommitUsage);
    expect(cliOutput(badSha)).not.toMatch(/OPENCODE_API_KEY|GITHUB_TOKEN|Invalid configuration/i);
  }));

it.effect("review-commit loads dotenv before constructing the credential provider", () =>
  Effect.gen(function*() {
    const cwd = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "review-commit-env-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    yield* Effect.tryPromise(() =>
      writeFile(join(cwd, ".env"), 'GITHUB_TOKEN="   "\nOPENCODE_API_KEY="   "\n')
    );
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: cwd };
    delete env.GITHUB_TOKEN;
    delete env.OPENCODE_API_KEY;
    const output = yield* Effect.tryPromise(() =>
      execute(
        process.execPath,
        [join(root, "scripts/review-commit.ts"), "acme/widget#1", sha, sha],
        {
          cwd,
          env,
          timeout: scriptTimeoutMs,
        },
      ).then(
        () => "unexpected success",
        (error: { stdout?: string; stderr?: string; }) =>
          (error.stdout ?? "") + (error.stderr ?? ""),
      )
    );
    expect(output).toContain("GITHUB_TOKEN is set but empty");
    expect(output).not.toContain("GitHub login unavailable");
  }).pipe(Effect.scoped));
