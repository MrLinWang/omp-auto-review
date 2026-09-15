import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { reviewWithFallback } from "../src/fallback.ts";
import { ReviewAttemptError, type ReviewAttempt } from "../src/attempt.ts";
import type { Verdict } from "../src/reviewer.ts";

const verdict: Verdict = { decision: "allow", risk: "low", authorization: "implicit", reason: "测试" };
const models = ["test/main", "test/backup"];
test("retry settings validate counts, timeouts and intervals", () => {
  assert.equal(parseConfig({}).retryCount, 1);
  assert.equal(parseConfig({ retryCount: 0 }).retryCount, 0);
  for (const config of [{ retryCount: -1 }, { retryCount: 6 }, { retryCount: 1.5 }, { retryDelayMs: 10001 }, { retryDelayMs: -1 }, { modelTimeoutMs: 0 }, { modelTimeoutMs: "100" }]) assert.throws(() => parseConfig(config));
  assert.equal(parseConfig({ reviewTimeoutMs: 60000, confirmationTimeoutMs: 45000, modelTimeoutMs: 10000 }).reviewTimeoutMs, 60000);
});

test("transient error retries the same model and preserves each attempt", async () => {
  const events: ReviewAttempt[] = [];
  const calls: string[] = [];
  const result = await reviewWithFallback(models, 1000, new AbortController().signal, async (model, _signal, _index, retry) => {
    calls.push(model);
    if (!retry) throw new ReviewAttemptError("rate_limit");
    return verdict;
  }, event => events.push(event), { retryCount: 1, retryDelayMs: 1, modelTimeoutMs: 100 });
  assert.deepEqual(calls, [models[0], models[0]]);
  assert.equal(result.reviewerModel, models[0]);
  assert.deepEqual(events.map(e => [e.attempt, e.status]), [[1, "running"], [1, "rate_limit"], [2, "running"], [2, "success"]]);
});

test("timeout aborts the first request then retries within the configured limit", async () => {
  let first!: AbortSignal;
  const result = await reviewWithFallback(models, 1000, new AbortController().signal, async (_model, signal, _index, retry) => {
    if (!retry) { first = signal; return new Promise(() => {}); }
    assert.equal(first.aborted, true);
    return verdict;
  }, undefined, { retryCount: 1, modelTimeoutMs: 15 });
  assert.equal(result.reviewerModel, models[0]);
});

test("retry exhaustion falls back; permanent errors skip retries; valid decisions do not retry", async () => {
  for (const failure of ["call_error", "auth_error", "missing_model", "output_limit"] as const) {
    const calls: string[] = [];
    const result = await reviewWithFallback(models, 1000, new AbortController().signal, async (model, _signal, index) => {
      calls.push(model);
      if (!index) throw new ReviewAttemptError(failure);
      return verdict;
    }, undefined, { retryCount: 2 });
    assert.equal(calls.filter(m => m === models[0]).length, failure === "call_error" ? 3 : 1);
    assert.equal(result.fallbackUsed, true);
  }
  for (const decision of ["allow", "deny", "ask"] as const) {
    let calls = 0;
    await reviewWithFallback(models, 1000, new AbortController().signal, async () => { calls++; return { ...verdict, decision }; }, undefined, { retryCount: 2 });
    assert.equal(calls, 1);
  }
});

test("cancelling backoff stops further attempts and insufficient budget skips waiting", async () => {
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(), 15);
  try {
    await assert.rejects(reviewWithFallback(models, 2000, controller.signal, async () => {
      calls++; throw new ReviewAttemptError("call_error");
    }, undefined, { retryCount: 2, retryDelayMs: 500 }), /已取消/);
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
  const attempted: string[] = [];
  await assert.rejects(reviewWithFallback(models, 100, new AbortController().signal, async model => {
    attempted.push(model); throw new ReviewAttemptError("call_error");
  }, undefined, { retryCount: 5, retryDelayMs: 500 }));
  assert.deepEqual(attempted, models);
});
