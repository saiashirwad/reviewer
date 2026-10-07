# Reviewer

Personal GitHub PR reviewer using Effect 4, Yielded's existing PR-review engine,
OpenCode Go, and Alchemy-managed Cloudflare Workers and Durable Objects.
Requires Node 24+ and TypeScript 7+. Local scripts run directly with Node.

## Development checks

`pnpm install` patches TypeScript 7 and oxlint with `@effect/tsgo`. Versions are
pinned to the supported integration matrix. The Effect language service powers
oxlint's type-aware correctness rules; TypeScript diagnostics stay in `pnpm typecheck`.

```sh
pnpm check
pnpm lint
pnpm fmt
pnpm fmt:check
```

`pnpm check` runs typecheck, oxlint, dprint's formatting check, and the Effect
Vitest suite. `pnpm fmt` applies the pinned TypeScript, JSON, Markdown, and YAML
formatters. The lockfile and generated local artifacts are excluded. HTTP and AI
APIs already used by the application are explicitly allowed in the Effect plugin;
other unstable APIs still produce diagnostics.

## Test a review without posting

Export `OPENCODE_API_KEY` in your shell. Then run:

```sh
pnpm check
pnpm smoke
GITHUB_TOKEN="$(gh auth token)" pnpm review 'saiashirwad/parserator#23'
```

`pnpm smoke` reviews a planted arithmetic bug and fails unless the model records
it and completes. `pnpm review` fetches real GitHub data and uses your OpenCode Go
account, but replaces the posting method with console output. It ignores existing
review markers so you can rerun the same PR. Its `Published` result means it
reached that method, not that GitHub received anything. Check the report for
`incomplete`; a successful process exit alone does not prove completion.

The default model is `muse-spark-1.3-contributor`. Muse uses the Responses API;
chat models use OpenAI-compatible completions. Both paths go through
`src/ReviewRuntime.ts` with budget wrappers in `src/museBudget.ts` and
`src/Spending.ts`. The default budget is $0.50 in estimated
OpenCode Go usage per review, not an additional subscription charge.

## Enroll a repository

Enrollment creates a GitHub webhook and enables automatic review posts. There is
no enrollment UI or GitHub App. The deployed allowlist is `reviewer.config.ts`.

1. Add each repository to `reviewer.config.ts`:

   ```ts
   repos: [
     { owner: "saiashirwad", repository: "parserator" },
     { owner: "your-org", repository: "your-repo", maxCostUsd: 0.5 },
   ];
   ```

2. Export `OPENCODE_API_KEY` and `GITHUB_TOKEN` in the deployment shell.
3. Check your credentials with `pnpm exec alchemy profile show --profile admin`.
   If you need a new profile, use `pnpm exec alchemy profile edit`.
4. Redeploy the production stack:

   ```sh
   GITHUB_TOKEN="$(gh auth token)" pnpm exec alchemy deploy --profile admin --stage prod --yes
   ```

Use the same profile and stage for later deployments. The `admin` profile is the
connected profile on this machine. Removing an entry and redeploying removes its
webhook. An empty list disables enrollment but keeps the Worker deployed.

Alchemy reads both credentials with Effect `Config.Redacted` during Worker
initialization and binds them as Cloudflare secrets. It generates and retains a
webhook signing secret in its state. No API key is written into repository files.

The GitHub token needs repository read access, pull-request write access, and
webhook administration access. Reviews post as the token's GitHub user. This
scaffold uses per-repository webhooks, not a GitHub App.

Each pull request gets a Durable Object. Alchemy's durable callbacks schedule
reviews and retry interrupted jobs. An interrupted review restarts from the
beginning; model turns are not checkpointed. Completed head snapshots persist in
SQLite. Base reads fetch changed files at the immutable merge base on demand.
Closed PRs clear copied source.

Pushes enqueue a review. A `/review` comment from an owner, member, or collaborator
also enqueues one. A marker on an existing review suppresses repeat posting for
that head SHA. Markers are best-effort duplicate detection, not exactly-once
GitHub writes. Stale heads are checked before publication.

## Configure a repository

Place `.github/reviewer.json` on the base branch:

```json
{
  "model": "muse-spark-1.3-contributor",
  "maxCostUsd": 0.5,
  "guidance": "Focus on correctness and security.",
  "exclude": ["fixtures/**"]
}
```

The service reads this file at the merge base, so a PR cannot weaken its own
review. Set `enabled` to `false` to disable reviews. Other supported models use
chat completions and need a price entry in `src/Spending.ts`.

## Current verification limits

`pnpm check` runs TypeScript and 10 behavior tests with `@effect/vitest`. The
tests cover archive extraction, source snapshots, exclusions, report rendering,
GitHub review pagination, Responses transport, and budget boundaries.

The live Muse smoke test passes. A full dry run of parserator#23 at `da23550`
reviewed all 21 changed files and completed in about 157 seconds. It reported the
text-buffer overwrite at `src/incremental-input.ts:13`, with no pending paths and
about $0.012 in estimated usage.

The production Worker is deployed at
`https://reviewer-reviewer-prod-jrphhhng7aafhnju.texoport.workers.dev`. Parserator is
enrolled. A signed GitHub webhook triggered a Durable Object review of temporary
[PR #25](https://github.com/saiashirwad/parserator/pull/25). The deployed model
posted the correct blocking inline finding in about 15 seconds. A subsequent
`/review` trigger did not post a duplicate. The PR was closed without merging,
and its temporary branch was deleted.

Health, webhook signature enforcement, alarm-driven execution, model calls, and
GitHub posting have been exercised. Forced-eviction recovery and retry exhaustion
have not been tested.

The five-minute review limit comes from `@yielded/agent-pr-review`; the package
currently exposes no duration override. Interrupted reviews restart rather than
resume model turns. The reviewer reads repository source but does not execute it.
