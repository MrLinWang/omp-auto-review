import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("locked SDK documents the restricted-child coverage boundary", async () => {
  // The SDK exports a Bun-only runtime; inspect its pinned source without importing it in Node.
  const src = fileURLToPath(new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/", import.meta.url));
  const pkg = JSON.parse(await readFile(join(src, "../package.json"), "utf8"));
  assert.equal(pkg.version, "18.1.16");
  const executor = await readFile(join(src, "task/executor.ts"), "utf8");
  assert.match(executor, /preloadedExtensionPaths:\s*restrictToolNames\s*\?\s*\[\]\s*:\s*options\.preloadedExtensionPaths/);
  assert.match(executor, /preloadedPreparedExtensions:\s*restrictToolNames\s*\?\s*\[\]\s*:\s*options\.preloadedPreparedExtensions/);
});
