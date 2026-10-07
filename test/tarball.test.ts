import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Tarball from "../src/Tarball.ts";

/** Builds a gzipped tarball shaped like GitHub's: everything under one root directory. */
const githubTarball = (files: Record<string, string | Uint8Array>) => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-tar-"));
  const root = join(dir, "owner-repo-abc1234");
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const archive = join(dir, "repo.tar.gz");
  execFileSync("tar", ["--format", "pax", "-czf", archive, "-C", dir, "owner-repo-abc1234"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return new Blob([readFileSync(archive)]).stream();
};

const collect = async (stream: ReadableStream<Uint8Array>, maxFileBytes = 1024) => {
  const entries = new Map<string, Tarball.Entry>();
  for await (const entry of Tarball.entries(stream, { maxFileBytes })) {
    entries.set(entry.path, entry);
  }
  return entries;
};

test("reads text files, strips the root, and keeps long paths", async () => {
  const longPath = `${"nested/".repeat(20)}deep.ts`;
  const entries = await collect(
    githubTarball({
      "README.md": "# hello\n",
      "src/index.ts": "export const a = 1;\n",
      [longPath]: "export const deep = true;\n",
    }),
  );

  assert.deepEqual(entries.get("README.md"), { path: "README.md", text: "# hello\n" });
  assert.deepEqual(entries.get("src/index.ts"), {
    path: "src/index.ts",
    text: "export const a = 1;\n",
  });
  assert.equal(longPath.length > 100, true);
  assert.deepEqual(entries.get(longPath), { path: longPath, text: "export const deep = true;\n" });
});

test("marks binary and oversized files as skipped", async () => {
  const entries = await collect(
    githubTarball({
      "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      "big.txt": "x".repeat(4_096),
      "small.txt": "ok\n",
    }),
  );

  assert.deepEqual(entries.get("logo.png"), { path: "logo.png", skipped: "binary" });
  assert.deepEqual(entries.get("big.txt"), { path: "big.txt", skipped: "too-large" });
  assert.deepEqual(entries.get("small.txt"), { path: "small.txt", text: "ok\n" });
});
