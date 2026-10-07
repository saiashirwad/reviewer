import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Manifest } from "../src/Management.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/reviewer.ts", import.meta.url));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const fixture = {
  model: "muse-spark-1.3-contributor",
  repos: [{ owner: "example", repository: "existing", guidance: "Keep this override." }],
  deployment: { profile: "admin", stage: "prod", url: "https://example.workers.dev" },
};

const sandbox = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "reviewer-cli-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

it.effect("edits the real manifest locally and preserves overrides on repeated additions", () =>
  Effect.gen(function*() {
    const cwd = yield* sandbox;
    yield* Effect.tryPromise(() => writeFile(join(cwd, "reviewer.json"), JSON.stringify(fixture)));
    for (const repo of ["Example/Existing", "https://github.com/example/new", "example/new"]) {
      yield* Effect.tryPromise(() =>
        execute(process.execPath, [cli, "repos", "add", repo], { cwd })
      );
    }
    const added = yield* decodeManifest(
      yield* Effect.tryPromise(() => readFile(join(cwd, "reviewer.json"), "utf8")),
    );
    expect(added.repos).toEqual([...fixture.repos, { owner: "example", repository: "new" }]);
    yield* Effect.tryPromise(() =>
      execute(process.execPath, [cli, "repos", "remove", "EXAMPLE/NEW"], { cwd })
    );
    const removed = yield* decodeManifest(
      yield* Effect.tryPromise(() => readFile(join(cwd, "reviewer.json"), "utf8")),
    );
    expect(removed).toEqual(fixture);
  }));

it.effect("passes the saved production target and credentials through the real deploy entrypoint", () =>
  Effect.gen(function*() {
    const cwd = yield* sandbox;
    const executable = join(cwd, "pnpm");
    yield* Effect.tryPromise(() => writeFile(join(cwd, "reviewer.json"), JSON.stringify(fixture)));
    yield* Effect.tryPromise(() =>
      writeFile(
        executable,
        `#!${process.execPath}\n`
          + `require('node:fs').writeFileSync('deployment.json', JSON.stringify({args:process.argv.slice(2), github:process.env.GITHUB_TOKEN, key:process.env.OPENCODE_API_KEY}));\n`,
      )
    );
    yield* Effect.tryPromise(() => chmod(executable, 0o755));
    yield* Effect.tryPromise(() =>
      writeFile(
        join(cwd, ".env"),
        "OPENCODE_API_KEY=dotenv-test-key\nGITHUB_TOKEN=dotenv-test-token\n",
      )
    );
    yield* Effect.tryPromise(() =>
      execute(process.execPath, [cli, "deploy"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH ?? ""}`,
          GITHUB_TOKEN: "shell-test-token",
          OPENCODE_API_KEY: "shell-test-key",
        },
      })
    );
    const deployment = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
      args: Schema.Array(Schema.String),
      github: Schema.String,
      key: Schema.String,
    })))(
      yield* Effect.tryPromise(() => readFile(join(cwd, "deployment.json"), "utf8")),
    );
    expect(deployment.args).toEqual([
      "exec",
      "alchemy",
      "deploy",
      "--profile",
      "admin",
      "--stage",
      "prod",
      "--yes",
    ]);
    expect(deployment.github).toBe("shell-test-token");
    expect(deployment.key).toBe("shell-test-key");
    expect(deployment.args).not.toContain("shell-test-token");
    expect(deployment.args).not.toContain("shell-test-key");
    yield* Effect.tryPromise(() =>
      execute(process.execPath, [cli, "deploy"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH ?? ""}`,
          GITHUB_TOKEN: undefined,
          OPENCODE_API_KEY: undefined,
        },
      })
    );
    const dotenvDeployment = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
      github: Schema.String,
      key: Schema.String,
    })))(yield* Effect.tryPromise(() => readFile(join(cwd, "deployment.json"), "utf8")));
    expect(dotenvDeployment.github).toBe("dotenv-test-token");
    expect(dotenvDeployment.key).toBe("dotenv-test-key");
  }));

it.effect("posts requests only for open, unreviewed PRs through the real executable", () =>
  Effect.gen(function*() {
    const cwd = yield* sandbox;
    const executable = join(cwd, "gh");
    yield* Effect.tryPromise(() => writeFile(join(cwd, "reviewer.json"), JSON.stringify(fixture)));
    yield* Effect.tryPromise(() =>
      writeFile(
        executable,
        `#!${process.execPath}\n`
          + `const fs = require('node:fs');\n`
          + `const args = process.argv.slice(2);\n`
          + `fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');\n`
          + `const endpoint = args.find(a => a.startsWith('repos/')) ?? '';\n`
          + `let result;\n`
          + `if(args.includes('POST')) {fs.writeFileSync('comment.json',JSON.stringify({args,gh:process.env.GH_TOKEN,github:process.env.GITHUB_TOKEN}));result={html_url:'https://github.com/example/existing/pull/1#issuecomment-123'};}\n`
          + `else if(endpoint.endsWith('/hooks')) result = [[{active:true,events:['pull_request','issue_comment'],config:{url:'https://example.workers.dev/__alchemy/github/example/existing'}}]];\n`
          + `else if(endpoint.includes('/reviews')) result = process.env.PR_STATE==='fresh'?[[]]:[[{body:'other review'}],[{body:'<!-- reviewer:head123 -->'}]];\n`
          + `else if(endpoint.includes('/pulls/')) result = {state:process.env.PR_STATE==='fresh'?'open':process.env.PR_STATE,draft:false,head:{sha:'head123'},base:{sha:'base123'}};\n`
          + `else if(args.includes('user')) result = {login:'example'};\n`
          + `else if(endpoint === 'repos/example/existing') result = {permissions:{push:true,admin:true},owner:{login:'example',type:'User'}};\n`
          + `else {console.error('Unexpected GitHub operation');process.exit(1);}\n`
          + `console.log(JSON.stringify(result));\n`,
      )
    );
    yield* Effect.tryPromise(() => chmod(executable, 0o755));
    for (const state of ["closed", "open"]) {
      yield* Effect.tryPromise(() =>
        execute(process.execPath, [cli, "request", "https://github.com/example/existing/pull/1"], {
          cwd,
          env: {
            ...process.env,
            PATH: `${cwd}:${process.env.PATH ?? ""}`,
            GITHUB_TOKEN: "test-token",
            PR_STATE: state,
          },
        })
      );
    }
    const calls = yield* Effect.tryPromise(() => readFile(join(cwd, "calls.jsonl"), "utf8"));
    expect(calls).not.toContain('"POST"');
    expect(calls).not.toContain("/comments");
    expect(calls).toContain("/reviews");
    const result = yield* Effect.tryPromise(() =>
      execute(process.execPath, [cli, "request", "https://github.com/example/existing/pull/1"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH ?? ""}`,
          GITHUB_TOKEN: "test-token",
          PR_STATE: "fresh",
        },
      })
    );
    const comment = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
      args: Schema.Array(Schema.String),
      gh: Schema.String,
      github: Schema.String,
    })))(yield* Effect.tryPromise(() => readFile(join(cwd, "comment.json"), "utf8")));
    expect(comment.args.slice(-4)).toEqual(["--method", "POST", "--field", "body=/review"]);
    expect(comment.gh).toBe("test-token");
    expect(comment.github).toBe("test-token");
    expect(result.stdout).toContain("Request submitted:");
    expect(result.stdout).not.toContain("test-token");
  }));
