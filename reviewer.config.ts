import type { ReviewerConfig } from "./src/Settings.ts";

/**
 * Repositories listed here get a webhook on the next `pnpm run deploy`; removing
 * one deletes its webhook. A repo can override settings with `.github/reviewer.json`.
 *
 * Muse Spark 1.3 Contributor uses Responses. Other supported models use chat
 * completions and must have a price in src/Spending.ts.
 * See https://opencode.ai/docs/go/#endpoints
 */
const config: ReviewerConfig = {
  model: "muse-spark-1.3-contributor",
  repos: [
    // { owner: "saiashirwad", repository: "some-repo" },
    // { owner: "saiashirwad", repository: "other-repo", model: "kimi-k2.7-code" },
  ],
};

export default config;
