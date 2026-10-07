/**
 * Runs the reviewer against a small synthetic change through OpenCode Go.
 *
 *   OPENCODE_API_KEY=... node scripts/smoke.ts [model]
 */
import { NodeRuntime } from "@effect/platform-node";
import { Review } from "@yielded/agent-pr-review";
import { Config, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import assert from "node:assert/strict";
import * as OpenCode from "../src/OpenCode.ts";
import * as ReviewRuntime from "../src/ReviewRuntime.ts";
import { fromMaps } from "../src/Snapshot.ts";

const base = `export const average = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
`;

const head = `export const average = (values: ReadonlyArray<number>): number =>
  values.reduce((sum, value) => sum + value, 0) / (values.length - 1);
`;

const caller = `import { average } from "./math.ts";

export const meanLatency = (samples: ReadonlyArray<number>) => average(samples);
`;

const patch = `@@ -1,2 +1,2 @@
 export const average = (values: ReadonlyArray<number>): number =>
-  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
+  values.reduce((sum, value) => sum + value, 0) / (values.length - 1);
`;

const snapshot = fromMaps({
  base: new Map([
    ["src/math.ts", base],
    ["src/latency.ts", caller],
  ]),
  head: new Map([
    ["src/math.ts", head],
    ["src/latency.ts", caller],
  ]),
});

const program = Effect.gen(function*() {
  const modelId = process.argv[2] ?? OpenCode.DEFAULT_MODEL;
  const apiKey = yield* Config.Redacted("OPENCODE_API_KEY");
  yield* Effect.log(`Reviewing with opencode-go/${modelId}`);
  const request = Review.ReviewRequest.make({
    title: "Simplify average",
    description: "Drop the empty-array branch from average.",
    baseRevision: "base0000",
    headRevision: "head0000",
    changes: [Review.ReviewChange.make({ path: "src/math.ts", patch })],
    unreviewedPaths: [],
  });
  const sessionId = `smoke-${crypto.randomUUID()}`;
  const result = yield* ReviewRuntime.runReview({
    request,
    snapshot,
    apiKey,
    sessionId,
    model: modelId,
    limitMicrousd: 500_000,
    guidance: undefined,
  });

  if (result._tag === "Skipped") {
    return yield* Effect.fail(new Error(`Smoke review skipped: ${result.reason}`));
  }

  console.log(JSON.stringify(result.outcome, null, 2));
  assert.equal(result.outcome.incomplete, undefined, "The smoke review must complete");
  assert.ok(
    result.outcome.report.findings.some(
      (finding) =>
        finding.path === "src/math.ts" && finding.line === 2 && finding.category === "correctness",
    ),
    "The reviewer must identify the planted arithmetic defect",
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(FetchHttpClient.layer)));
