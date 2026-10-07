import type { Review } from "@yielded/agent-pr-review";
import type { ReviewComment } from "./GitHub.ts";

type Finding = Review.ReviewFinding;

/** Hidden in every published review so a retried job never posts twice for one commit. */
export const marker = (headSha: string) => `<!-- reviewer:${headSha} -->`;

const severityLabel: Record<Finding["severity"], string> = {
  blocking: "Blocking",
  important: "Important",
  nit: "Nit",
};

const heading = (finding: Finding) =>
  `**${severityLabel[finding.severity]} · ${finding.category}: ${finding.title}**`;

const listed = (finding: Finding) =>
  `- ${heading(finding)} — \`${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}\`\n\n  ${finding.body.replaceAll("\n", "\n  ")}`;

const thousands = (count: number) =>
  count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);

const footer = (outcome: Review.ReviewOutcome, unreviewed: ReadonlyArray<string>) => {
  const { usage } = outcome;
  const notes = [
    `${outcome.turns} turns`,
    `${thousands(usage.inputTokens)} input (${thousands(usage.cachedInputTokens)} cached) / ${thousands(usage.outputTokens)} output tokens`,
    ...(usage.estimatedCostMicrousd === undefined
      ? []
      : [`~$${(usage.estimatedCostMicrousd / 1_000_000).toFixed(3)}`]),
    ...(outcome.incomplete ? ["incomplete"] : []),
    ...(outcome.exhausted ? [`stopped at the ${outcome.exhausted} budget`] : []),
    ...(unreviewed.length > 0 ? [`${unreviewed.length} path(s) not reviewed`] : []),
  ];
  return `<sub>${notes.join(" · ")}</sub>`;
};

export interface Rendered {
  readonly body: string;
  readonly comments: ReadonlyArray<ReviewComment>;
  /** The same review with every finding in the body, for when GitHub rejects inline anchors. */
  readonly bodyOnly: string;
}

export const render = (options: {
  readonly outcome: Review.ReviewOutcome;
  readonly model: string;
  readonly headSha: string;
  readonly unreviewedPaths: ReadonlyArray<string>;
}): Rendered => {
  const { outcome, model, headSha, unreviewedPaths } = options;
  const { findings, summary } = outcome.report;
  const anchored = findings.filter((finding) => finding.line !== undefined);
  const unanchored = findings.filter((finding) => finding.line === undefined);

  const document = (inBody: ReadonlyArray<Finding>) =>
    [
      marker(headSha),
      `**Review** · \`${model}\` · ${headSha.slice(0, 7)}`,
      summary,
      ...(inBody.length > 0 ? [inBody.map(listed).join("\n\n")] : []),
      ...(outcome.pendingPaths && outcome.pendingPaths.length > 0
        ? [`Not fully read: ${outcome.pendingPaths.map((path) => `\`${path}\``).join(", ")}`]
        : []),
      footer(outcome, unreviewedPaths),
    ].join("\n\n");

  return {
    body: document(unanchored),
    comments: anchored.map((finding) => ({
      path: finding.path,
      line: finding.line!,
      body: `${heading(finding)}\n\n${finding.body}`,
    })),
    bodyOnly: document(findings),
  };
};
