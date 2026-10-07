# Reviewer

Personal GitHub PR reviewer using Effect 4, Yielded's existing PR-review engine,
OpenCode Go, and Alchemy-managed Cloudflare Workers and Durable Objects.
Requires Node 24+ and TypeScript 7+. Local scripts run directly with Node.

## Test a review without posting

Export `OPENCODE_API_KEY` in your shell. Then run:

```sh
pnpm check
pnpm smoke
GITHUB_TOKEN="$(gh auth token)" pnpm review 'saiashirwad/parserator#23'
```

`pnpm smoke` reviews a planted arithmetic bug and fails unless the model records
it and completes. `pnpm review` fetches real GitHub data and uses your OpenCode Go
account, but replaces the posting method with console output. Its `Published`
result means it reached that method, not that GitHub received anything.

The default model is `muse-spark-1.3-contributor`. Muse uses the Responses API and
only supports automatic tool choice. `src/Responses.ts` adapts Yielded's tool
choices and accounts for reported usage. The default budget is $0.50 in estimated
OpenCode Go usage per review, not an additional subscription charge.

## Deploy to selected repositories

Deployment creates webhooks and enables automatic posting. No deployment has
been performed yet. The latest dry run of parserator#23 read every patch but hit
Yielded's five-minute deadline with zero recorded findings. That result is
incomplete, not evidence that the PR has no bugs.

1. Add your repositories to `reviewer.config.ts`.
2. Export `OPENCODE_API_KEY` and `GITHUB_TOKEN` in the deployment shell.
3. Authenticate Cloudflare with `pnpm exec alchemy login`.
4. Run `pnpm deploy`.

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

The local HTTP adapter tests, source snapshot tests, typecheck, and live Muse
smoke test pass. Cloudflare deployment and alarm recovery have not been exercised.
The five-minute review limit comes from `@yielded/agent-pr-review`; the package
currently exposes no duration override. No repository code is executed.
