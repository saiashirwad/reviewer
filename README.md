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
APIs used by the application and CLI are explicitly allowed in the Effect plugin;
other unstable APIs still produce diagnostics.

## Set up management commands

Copy `.env.example` to `.env` and replace the OpenCode Go API key:

```sh
cp -n .env.example .env
gh auth login --hostname github.com
pnpm exec alchemy profile show --profile admin
pnpm reviewer --help
```

The copy command leaves an existing `.env` intact. If the Cloudflare profile
needs setup, run `pnpm exec alchemy profile edit`.
`.env` is ignored by Git. Shell variables override `.env`. The CLI uses
`GITHUB_TOKEN` when supplied and otherwise reuses `gh` authentication for
`github.com`. Tokens are passed to child processes as environment variables,
not command arguments.

`reviewer.json` stores the repository list, review defaults, and deployment
target. The current target is the existing `admin` profile and `prod` stage.
Keep that target for production updates. A different profile or stage can
create a separate stack rather than update production.
If you deliberately change targets, update `deployment.url` from Alchemy's
output before you use `status` or `request`.

## Test a review without posting

Set `OPENCODE_API_KEY` in `.env` or your shell. Then run:

```sh
pnpm check
pnpm smoke
pnpm review https://github.com/saiashirwad/parserator/pull/23
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
no GitHub App installation. Add a repository and deploy in one command:

```sh
pnpm reviewer repos add your-org/your-repo --deploy
pnpm reviewer status
```

To stage several changes before one deployment, omit `--deploy`:

```sh
pnpm reviewer repos add your-org/first-repo
pnpm reviewer repos add https://github.com/your-org/second-repo
pnpm reviewer repos list
pnpm reviewer deploy
```

The CLI validates `reviewer.json` and preserves existing per-repository settings.
Repeated additions and removals are safe. Local edits do not enroll a repository
until deployment succeeds. If deployment fails, the edits remain available for
retry. Alchemy can apply part of a failed deployment, so check `status` after a
failure rather than assume GitHub is unchanged.

`pnpm run deploy` uses the same management command. Removing a repository and
deploying deletes its managed webhook:

```sh
pnpm reviewer repos remove your-org/your-repo --deploy
```

An empty repository list keeps the Worker deployed without enrollment. `status`
checks the configured Worker URL and GitHub webhooks for locally listed
repositories. It does not enumerate repositories removed from the local list or
prove that a model review can complete.

Alchemy reads both credentials with Effect `Config.Redacted` during Worker
initialization and binds them as Cloudflare secrets. It generates and retains a
webhook signing secret in its state. API keys stay in your shell or ignored
`.env`, not in committed configuration.

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

## Request a deployed review

Use a PR URL or quote `owner/repo#number`:

```sh
pnpm reviewer request https://github.com/saiashirwad/parserator/pull/23
pnpm reviewer request 'saiashirwad/parserator#23'
```

The command checks enrollment, the webhook, and the PR before it creates a new
`/review` conversation comment. It reports closed or draft PRs and heads that
already have a review marker without posting another request. A posted request
means GitHub accepted the comment, not that the review has finished. The Worker
still checks repository settings, exclusions, budgets, and the head before
publication.

You can also write `/review` directly in GitHub. Only new comments from an owner,
member, or collaborator trigger the Worker. Editing a comment does not trigger
another review. A new commit is required to review an already-reviewed head.
`status` and `request` need permission to read repository webhooks. If your token
can comment but cannot read webhooks, write `/review` in GitHub instead.

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

`pnpm check` runs TypeScript and behavior tests with `@effect/vitest`. The
tests cover archive extraction, source snapshots, exclusions, report rendering,
GitHub review pagination, Responses transport, budget boundaries, and management
commands. CLI tests use local adapters for deployment and comment writes; they
do not deploy or post to GitHub.

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
