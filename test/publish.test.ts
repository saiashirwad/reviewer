import assert from "node:assert/strict";
import { test } from "node:test";
import { Review } from "@yielded/agent-pr-review";
import * as Publish from "../src/Publish.ts";

test("render splits anchored findings into inline comments", () => {
  const outcome = Review.ReviewOutcome.make({
    report: Review.ReviewReport.make({
      summary: "Summary line.",
      findings: [
        Review.ReviewFinding.make({
          path: "src/a.ts",
          line: 10,
          severity: "important",
          category: "correctness",
          title: "Bug",
          body: "Details.",
        }),
        Review.ReviewFinding.make({
          path: "src/b.ts",
          severity: "nit",
          category: "maintainability",
          title: "Nit",
          body: "No line.",
        }),
      ],
    }),
    turns: 2,
    usage: Review.ReviewUsage.make({
      inputTokens: 100,
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
    }),
  });

  const rendered = Publish.render({
    outcome,
    model: "test-model",
    headSha: "abc1234567890abcdef1234567890abcdef1234",
    unreviewedPaths: [],
  });

  assert.equal(rendered.comments.length, 1);
  assert.equal(rendered.comments[0]?.path, "src/a.ts");
  assert.ok(rendered.body.includes("Nit"));
  assert.ok(rendered.bodyOnly.includes("src/a.ts"));
  assert.ok(rendered.body.includes(Publish.marker("abc1234567890abcdef1234567890abcdef1234")));
});
