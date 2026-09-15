import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ConfigStore, defaults, parseConfig } from "../src/config.ts";
import { ReviewEngine } from "../src/engine.ts";
import { appendReviewLog, type ReviewLogRecord } from "../src/review-log.ts";
import { builtin, call, context, workspace } from "./helpers.ts";

test("review log path is optional, validated and survives config save/reload", async () => {
  const w = await workspace();
  try {
    assert.equal(parseConfig({}).reviewLogPath, undefined);
    for (const reviewLogPath of [null, true, 123, [], "", "  ", "a\0b"]) {
      assert.throws(() => parseConfig({ reviewLogPath }));
    }
    const store = new ConfigStore(w.root);
    await store.save(parseConfig({ reviewLogPath: "logs/reviews.jsonl" }));
    assert.equal((await store.load()).reviewLogPath, "logs/reviews.jsonl");
    await store.save(parseConfig({}));
    assert.equal((await store.load()).reviewLogPath, undefined);
  } finally { await w.cleanup(); }
});

test("logs every model conclusion before human override, appending full redacted parameters", async () => {
  const w = await workspace();
  try {
    const file = join(w.root, "logs", "reviews.jsonl");
    for (const decision of ["allow", "deny", "ask", "error"] as const) {
      const engine = new ReviewEngine({
        config: () => ({ ...defaults, model: "test/model", reviewLogPath: "logs/reviews.jsonl", bashAllowCommands: [] }),
        sources: () => [builtin("bash")], protectedRoots: [],
        review: async () => {
          if (decision === "error") throw new Error("provider failure");
          return { decision, risk: "low", authorization: "implicit", reason: "测试", reviewerModel: "test/backup", fallbackUsed: true };
        },
        audit: async () => {},
        reviewLog: (path, record) => appendReviewLog(w.root, path, record),
      });
      const ctx = context(w.cwd, async () => {
        const records = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(records.at(-1).decision, decision);
        return "仅批准本次调用";
      }).ctx;
      await engine.handle(call("bash", { command: "npm test\nprintf done", token: "hidden", extra: { password: "hidden" } }, decision), ctx);
    }
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("hidden"));
    const records: ReviewLogRecord[] = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.decision), ["allow", "deny", "ask", "error"]);
    assert.deepEqual(records.map(record => record.operation.toolCallId), ["allow", "deny", "ask", "error"]);
    assert.equal(records[0].operation.input.command, "npm test\nprintf done");
    assert.equal(records[0].cwd, w.cwd);
    assert.equal(records[0].model, "test/backup");
    assert.equal(records[0].fallbackUsed, true);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(w.root, "logs"))).mode & 0o777, 0o700);
    // Absolute paths append to the same file as agent-directory-relative paths.
    await appendReviewLog(w.root, file, records[0]);
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 5);
  } finally { await w.cleanup(); }
});

test("disabled logs, fast paths and missing models do not write; write failures block", async () => {
  const w = await workspace();
  try {
    let writes = 0;
    let reviews = 0;
    const config = { ...defaults, model: "test/model" as string | undefined, reviewLogPath: undefined as string | undefined };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash"), builtin("read")], protectedRoots: [],
      review: async () => { reviews++; return { decision: "allow", risk: "low", authorization: "implicit", reason: "ok" }; },
      audit: async () => {},
      reviewLog: async () => { writes++; throw new Error("disk failure"); },
    });
    const ctx = context(w.cwd).ctx;
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), ctx), undefined);
    assert.equal(writes, 0);
    config.reviewLogPath = "reviews.jsonl";
    await engine.handle(call(), ctx);
    await engine.handle(call("read", { path: "new.txt" }), ctx);
    assert.equal(reviews, 1);
    assert.equal(writes, 0);
    assert.equal((await engine.handle(call("bash", { command: "npm test" }), ctx))?.block, true);
    assert.equal(writes, 1);
    config.model = undefined;
    await engine.handle(call("bash", { command: "npm test" }), ctx);
    assert.equal(writes, 1);
  } finally { await w.cleanup(); }
});
