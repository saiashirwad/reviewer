import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Management from "../src/Management.ts";

const decodeManifest = (input: unknown) =>
  Schema.decodeUnknownEffect(Management.Manifest)(input, Management.strictManifestOptions);

const sampleManifest = {
  model: "muse-spark-1.3-contributor",
  repos: [{ owner: "acme", repository: "widget" }],
  deployment: {
    profile: "admin",
    stage: "prod",
    url: "https://reviewer-reviewer-prod-jrphhhng7aafhnju.texoport.workers.dev",
  },
};

it.effect("parseRepo accepts shorthand and GitHub URLs", () =>
  Effect.gen(function*() {
    const shorthand = yield* Management.parseRepo("Acme/Widget");
    expect(shorthand).toEqual({ owner: "Acme", repository: "Widget" });

    const url = yield* Management.parseRepo("https://github.com/acme/widget");
    expect(url).toEqual({ owner: "acme", repository: "widget" });
  }));

it.effect("parseRepo rejects invalid targets", () =>
  Effect.gen(function*() {
    const badRepo = yield* Effect.flip(Management.parseRepo("acme/../evil"));
    expect(badRepo._tag).toBe("InvalidTarget");

    const foreign = yield* Effect.flip(Management.parseRepo("https://gitlab.com/acme/widget"));
    expect(foreign._tag).toBe("InvalidTarget");

    const normalizedTraversal = yield* Effect.flip(
      Management.parseRepo("https://github.com/acme/../widget/repo"),
    );
    expect(normalizedTraversal._tag).toBe("InvalidTarget");

    const encodedTraversal = yield* Effect.flip(
      Management.parseRepo("https://github.com/acme/%2e%2e/widget"),
    );
    expect(encodedTraversal._tag).toBe("InvalidTarget");

    const doubleSlash = yield* Effect.flip(
      Management.parseRepo("https://github.com/acme//widget"),
    );
    expect(doubleSlash._tag).toBe("InvalidTarget");

    const port = yield* Effect.flip(
      Management.parseRepo("https://github.com:444/acme/widget"),
    );
    expect(port._tag).toBe("InvalidTarget");

    const badOwner = yield* Effect.flip(Management.parseRepo("-leading/widget"));
    expect(badOwner._tag).toBe("SchemaError");
  }));

it.effect("parsePull accepts shorthand, URLs, and discussion fragments", () =>
  Effect.gen(function*() {
    const shorthand = yield* Management.parsePull("acme/widget#42");
    expect(shorthand).toEqual({ owner: "acme", repository: "widget", number: 42 });

    const url = yield* Management.parsePull(
      "https://github.com/acme/widget/pull/99#discussion_r123456789",
    );
    expect(url).toEqual({ owner: "acme", repository: "widget", number: 99 });
  }));

it.effect("parsePull rejects repo-only, traversal, and malformed shorthand", () =>
  Effect.gen(function*() {
    const repoOnly = yield* Effect.flip(Management.parsePull("acme/widget"));
    expect(repoOnly._tag).toBe("InvalidTarget");

    const traversal = yield* Effect.flip(
      Management.parsePull("https://github.com/acme/widget/pull/1/../secrets"),
    );
    expect(traversal._tag).toBe("InvalidTarget");

    const wrongPull = yield* Effect.flip(
      Management.parsePull("https://github.com/acme/widget/../repo/pull/1"),
    );
    expect(wrongPull._tag).toBe("InvalidTarget");

    const queryShorthand = yield* Effect.flip(Management.parsePull("acme/widget#1?junk"));
    expect(queryShorthand._tag).toBe("InvalidTarget");

    const doubleHash = yield* Effect.flip(Management.parsePull("acme/widget#1#junk"));
    expect(doubleHash._tag).toBe("InvalidTarget");
  }));

it.effect("manifest rejects unknown fields and duplicate repos", () =>
  Effect.gen(function*() {
    const unknownField = yield* Effect.flip(decodeManifest({ ...sampleManifest, typo: true }));
    expect(unknownField._tag).toBe("SchemaError");

    const duplicates = yield* Effect.flip(decodeManifest({
      ...sampleManifest,
      repos: [
        { owner: "Acme", repository: "widget" },
        { owner: "acme", repository: "Widget" },
      ],
    }));
    expect(duplicates._tag).toBe("SchemaError");
  }));

it.effect("manifest rejects malformed deployment URLs and nested setting typos", () =>
  Effect.gen(function*() {
    for (
      const url of [
        "https://bad host",
        "http://example.com",
        "https://token@example.com",
        "https://example.com/path",
        "https://example.com/?query=1",
        "https://example.com/#fragment",
        "https://exam\nple.com",
      ]
    ) {
      const error = yield* Effect.flip(decodeManifest({
        ...sampleManifest,
        deployment: { ...sampleManifest.deployment, url },
      }));
      expect(error._tag).toBe("SchemaError");
    }
    const error = yield* Effect.flip(decodeManifest({
      ...sampleManifest,
      repos: [{ owner: "acme", repository: "widget", maxCostUSD: 0.5 }],
    }));
    expect(error._tag).toBe("SchemaError");
    const invalidOwner = yield* Effect.flip(decodeManifest({
      ...sampleManifest,
      repos: [{ owner: "acme\n", repository: "widget" }],
    }));
    expect(invalidOwner._tag).toBe("SchemaError");
  }));

it.effect("pull numbers must be positive safe integers", () =>
  Effect.gen(function*() {
    for (const target of ["acme/widget#0", "acme/widget#9007199254740992"]) {
      const error = yield* Effect.flip(Management.parsePull(target));
      expect(error._tag).toBe("SchemaError");
    }
  }));

it.effect("parsePull accepts leading zeros in pull numbers", () =>
  Effect.gen(function*() {
    const parsed = yield* Management.parsePull("acme/widget#0042");
    expect(parsed).toEqual({ owner: "acme", repository: "widget", number: 42 });
  }));

it.effect("addRepo and removeRepo preserve overrides and casing", () =>
  Effect.gen(function*() {
    const manifest = yield* decodeManifest({
      ...sampleManifest,
      repos: [{
        owner: "Acme",
        repository: "Widget",
        guidance: "Keep it tight.",
        exclude: ["dist/**"],
      }],
    });

    const added = Management.addRepo(manifest, { owner: "acme", repository: "widget" });
    expect(added).toBe(manifest);
    expect(added.repos[0]?.guidance).toBe("Keep it tight.");

    const withNew = Management.addRepo(manifest, { owner: "beta", repository: "demo" });
    expect(withNew.repos).toHaveLength(2);

    const removed = Management.removeRepo(withNew, { owner: "ACME", repository: "widget" });
    expect(removed.repos).toEqual([{ owner: "beta", repository: "demo" }]);
    expect(Management.removeRepo(removed, { owner: "beta", repository: "demo" }).repos).toEqual([]);
  }));
