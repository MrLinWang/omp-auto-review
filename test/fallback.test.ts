import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewWithFallback } from "../src/fallback.ts";
import { parseConfig } from "../src/config.ts";
import { parseVerdict, type Verdict } from "../src/reviewer.ts";
import { ReviewAttemptError, type ReviewAttempt } from "../src/attempt.ts";

const allow: Verdict = { decision: "allow", risk: "low", authorization: "implicit", reason: "测试批准" };
const models = ["test/primary", "test/backup"];

test("failed attempts report safe categories and retain both models", async () => {
  const events: ReviewAttempt[] = [];
  await assert.rejects(reviewWithFallback(models, 1000, new AbortController().signal, async (_model, _signal, index) => {
    if (index === 0) throw new ReviewAttemptError("invalid_response");
    throw Object.assign(new Error("secret credential in server response"), { status: 401 });
  }, event => events.push(event)));
  assert.deepEqual(events.map(event => [event.model, event.status]), [
    [models[0], "running"], [models[0], "invalid_response"],
    [models[1], "running"], [models[1], "auth_error"],
  ]);
  assert.ok(!JSON.stringify(events).includes("secret"));
  assert.ok(events.every(event => event.elapsedMs >= 0));
  const result = await reviewWithFallback(models, 1000, new AbortController().signal, async () => allow, () => { throw new Error("UI failed"); });
  assert.equal(result.decision, "allow");
});

test("fallback config validates exact names and preserves ordered unique candidates", () => {
  assert.deepEqual(parseConfig({}).fallbackModels, []);
  assert.deepEqual(parseConfig({ fallbackModels: [models[1], models[1], models[0]] }).fallbackModels, [models[1], models[0]]);
  for (const fallbackModels of [null, "test/backup", ["fuzzy"], [42], Array(9).fill("test/backup"), ["test/model with spaces"]]) {
    assert.throws(() => parseConfig({ fallbackModels }));
  }
  assert.throws(() => parseConfig({ model: models[0], fallbackModels: [models[0]] }));
  // Transport metadata must not be forgeable by a model response.
  assert.throws(() => parseVerdict(JSON.stringify({ ...allow, reviewerModel: "test/forged" })));
  assert.throws(() => parseVerdict(JSON.stringify({ ...allow, fallbackUsed: true })));
});

test("all valid decisions end the chain, even ask and deny", async () => {
  for (const decision of ["allow", "ask", "deny"] as const) {
    const calls: string[] = [];
    const result = await reviewWithFallback(models, 1000, new AbortController().signal, async model => {
      calls.push(model);
      return { ...allow, decision };
    });
    assert.equal(result.decision, decision);
    assert.equal(result.reviewerModel, models[0]);
    assert.equal(result.fallbackUsed, undefined);
    assert.deepEqual(calls, [models[0]]);
  }
});

test("errors and invalid JSON advance to a fallback, whose decision is final", async () => {
  for (const fail of [() => { throw new Error("credential secret-value"); }, () => parseVerdict("not JSON")]) {
    const result = await reviewWithFallback(models, 1000, new AbortController().signal, async (_model, _signal, index) => {
      if (index === 0) return fail();
      return { ...allow, decision: "deny" };
    });
    assert.equal(result.decision, "deny");
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.reviewerModel, models[1]);
    assert.ok(!JSON.stringify(result).includes("secret-value"));
  }
});

test("a hung attempt is aborted while fallback retains time, and late success is ignored", async () => {
  let firstSignal!: AbortSignal;
  let finish!: (verdict: Verdict) => void;
  const result = await reviewWithFallback(models, 200, new AbortController().signal, async (_model, signal, index) => {
    if (index === 0) {
      firstSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    }
    assert.equal(firstSignal.aborted, true);
    return { ...allow, decision: "deny" };
  });
  finish(allow);
  assert.equal(result.decision, "deny");
  assert.equal(result.reviewerModel, models[1]);
});

test("cancellation prevents fallback and all failures remain errors", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(reviewWithFallback(models, 1000, controller.signal, async model => {
    calls.push(model);
    controller.abort();
    return new Promise(() => {});
  }), /已取消/);
  assert.deepEqual(calls, [models[0]]);
  await assert.rejects(reviewWithFallback(models, 1000, controller.signal, async () => { assert.fail("already cancelled"); }));
  await assert.rejects(reviewWithFallback(models, 1000, new AbortController().signal, async () => {
    throw new Error("secret error");
  }), error => String(error).includes("所有审核模型") && !String(error).includes("secret"));
  await assert.rejects(reviewWithFallback(models, 30, new AbortController().signal, async () => new Promise(() => {})), /所有审核模型/);
});
