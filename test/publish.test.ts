import { expect, it } from "@effect/vitest";
import { Review } from "@yielded/agent-pr-review";
import * as Publish from "../src/Publish.ts";

it("render splits anchored findings into inline comments", () => {
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

  expect(rendered.comments).toEqual([{
    path: "src/a.ts",
    line: 10,
    body: "**Important · correctness: Bug**\n\nDetails.",
  }]);
  expect(rendered.body).toContain("- **Nit · maintainability: Nit** — `src/b.ts`\n\n  No line.");
  expect(rendered.body).not.toContain("Details.");
  expect(rendered.bodyOnly).toContain(
    "- **Important · correctness: Bug** — `src/a.ts:10`\n\n  Details.",
  );
  expect(rendered.bodyOnly).toContain(
    "- **Nit · maintainability: Nit** — `src/b.ts`\n\n  No line.",
  );
});
