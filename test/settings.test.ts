import assert from "node:assert/strict";
import { test } from "node:test";
import * as Settings from "../src/Settings.ts";

test("globs match segments, spans, and basenames", () => {
  const matches = Settings.matcher(["dist/**", "*.min.js", "src/gen/*.ts", "pnpm-lock.yaml"]);

  assert.equal(matches("dist/index.js"), true);
  assert.equal(matches("dist/a/b/c.js"), true);
  assert.equal(matches("app/vendor.min.js"), true);
  assert.equal(matches("src/gen/types.ts"), true);
  assert.equal(matches("src/gen/nested/types.ts"), false);
  assert.equal(matches("packages/web/pnpm-lock.yaml"), true);
  assert.equal(matches("src/index.ts"), false);
  assert.equal(matches("distribution/index.js"), false);
});

test("repo file overrides the model and extends exclusions", () => {
  const settings = Settings.resolve(
    { model: "deepseek-v4.1-flash", repos: [] },
    { owner: "o", repository: "r", exclude: ["docs/**"] },
  );
  const applied = Settings.applyRepoFile(settings, {
    model: "kimi-k2.7-code",
    exclude: ["fixtures/**"],
    guidance: "Focus on security.",
  });

  assert.equal(applied.model, "kimi-k2.7-code");
  assert.equal(applied.guidance, "Focus on security.");
  assert.equal(applied.exclude.includes("pnpm-lock.yaml"), true);
  assert.equal(applied.exclude.includes("docs/**"), true);
  assert.equal(applied.exclude.includes("fixtures/**"), true);
});
