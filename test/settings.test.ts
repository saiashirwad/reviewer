import { expect, it } from "@effect/vitest";
import * as Settings from "../src/Settings.ts";

it("globs match segments, spans, and basenames", () => {
  const matches = Settings.matcher(["dist/**", "*.min.js", "src/gen/*.ts", "pnpm-lock.yaml"]);

  expect(
    [
      "dist/index.js",
      "dist/a/b/c.js",
      "app/vendor.min.js",
      "src/gen/types.ts",
      "src/gen/nested/types.ts",
      "packages/web/pnpm-lock.yaml",
      "src/index.ts",
      "distribution/index.js",
    ].filter(matches),
  ).toEqual([
    "dist/index.js",
    "dist/a/b/c.js",
    "app/vendor.min.js",
    "src/gen/types.ts",
    "packages/web/pnpm-lock.yaml",
  ]);
});

it("repo file overrides the model and extends exclusions", () => {
  const settings = Settings.resolve(
    { model: "deepseek-v4.1-flash", repos: [] },
    { owner: "o", repository: "r", exclude: ["docs/**"] },
  );
  const applied = Settings.applyRepoFile(settings, {
    model: "kimi-k2.7-code",
    exclude: ["fixtures/**"],
    guidance: "Focus on security.",
  });

  expect(applied.model).toBe("kimi-k2.7-code");
  expect(applied.guidance).toBe("Focus on security.");
  const excluded = Settings.matcher(applied.exclude);
  expect(["docs/guide.md", "fixtures/example.ts", "src/main.ts"].filter(excluded)).toEqual([
    "docs/guide.md",
    "fixtures/example.ts",
  ]);
});
