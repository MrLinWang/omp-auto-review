import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgeOptions, JudgmentRequest } from "@oh-my-pi/pi-ai/judgment";
import { ConfigStore, defaults, jevBudgetMs, jevDefaults, parseConfig, type JevConfig } from "../src/config.ts";
import { buildJevRequest, gateJevAnswer, JEV_QUESTION_ID, jevAttemptModel, jevVerdict, parseJevResponse, reviewWithJev, type JevCandidate } from "../src/jev.ts";
import { buildReviewPayload } from "../src/reviewer.ts";
import { formatAttempts, ReviewAttemptError, type ReviewAttempt } from "../src/attempt.ts";
import { call, userHistory, workspace } from "./helpers.ts";

const jev = (extra: Record<string, unknown> = {}) => ({ jev: { ...extra } });

test("the jev block is optional and carries only the gating policy", () => {
  assert.equal(parseConfig({}).jev, undefined);
  assert.equal(parseConfig({ model: "p/m" }).jev, undefined);
  const parsed = parseConfig(jev())!.jev!;
  assert.deepEqual(parsed, { ...jevDefaults });
  assert.equal(parsed.confidenceThreshold, 0.85);
  assert.equal(parsed.timeoutMs, 5_000);
  assert.equal(parsed.retryCount, 1);
  assert.equal(parsed.retryDelayMs, 500);
});

test("removed connection and credential fields fail closed as unknown fields", () => {
  // The host owns the decision model and its credentials now; a stale block must not pass silently.
  for (const removed of [{ baseUrl: "https://api.typesafe.ai/v1/systemone" }, { model: "jev-latest" }, { apiKeyEnv: "TYPESAFE_API_KEY" }, { apiKey: "ts-secret-value" }]) {
    const error = (() => { try { parseConfig(jev(removed)); return undefined; } catch (e) { return e as Error; } })();
    assert.ok(error, `expected rejection of ${Object.keys(removed)[0]}`);
    assert.match(error!.message, /未知 jev 配置字段/);
    // The rejection names the field, never the attempted value.
    assert.ok(!error!.message.includes(String(Object.values(removed)[0])));
  }
  assert.throws(() => parseConfig(jev({ nope: true })), /未知 jev 配置字段/);
  assert.throws(() => parseConfig({ jev: [] }), /jev 必须是 JSON 对象/);
  assert.throws(() => parseConfig({ jev: "on" }), /jev 必须是 JSON 对象/);
});

test("the winning-probability threshold must be greater than 0.5 and at most 1", () => {
  for (const confidenceThreshold of [0.5, 0.4, 0, -1, 1.1, 2, Number.NaN, Number.POSITIVE_INFINITY, "0.9", null]) {
    assert.throws(() => parseConfig(jev({ confidenceThreshold })), /confidenceThreshold/);
  }
  assert.equal(parseConfig(jev({ confidenceThreshold: 0.5001 })).jev!.confidenceThreshold, 0.5001);
  assert.equal(parseConfig(jev({ confidenceThreshold: 1 })).jev!.confidenceThreshold, 1);
});

test("jev timeouts and retries are bounded and must fit inside the review budget", () => {
  for (const timeoutMs of [0, -1, 30_001, 1.5, "5000"]) assert.throws(() => parseConfig(jev({ timeoutMs })), /jev\.timeoutMs/);
  for (const retryCount of [-1, 4, 1.5]) assert.throws(() => parseConfig(jev({ retryCount })), /jev\.retryCount/);
  for (const retryDelayMs of [-1, 10_001, 1.5]) assert.throws(() => parseConfig(jev({ retryDelayMs })), /jev\.retryDelayMs/);
  // Worst case = every attempt timing out plus the waits between them.
  assert.equal(jevBudgetMs(parseConfig(jev()).jev), 5_000 * 2 + 500);
  assert.equal(jevBudgetMs(parseConfig(jev({ retryCount: 0 })).jev), 5_000);
  assert.equal(jevBudgetMs(parseConfig(jev({ enabled: false })).jev), 0);
  assert.equal(jevBudgetMs(undefined), 0);
  // The prefilter shares reviewTimeoutMs rather than extending the 110000ms total.
  assert.ok(jevBudgetMs(parseConfig(jev()).jev) < defaults.reviewTimeoutMs);
  assert.equal(parseConfig({ ...jev(), reviewTimeoutMs: 20_000, confirmationTimeoutMs: 90_000 }).reviewTimeoutMs, 20_000);
  assert.throws(() => parseConfig({ ...jev({ timeoutMs: 10_000, retryCount: 1 }), reviewTimeoutMs: 20_000 }), /必须小于 reviewTimeoutMs/);
  assert.throws(() => parseConfig({ ...jev({ timeoutMs: 20_000, retryCount: 0 }), reviewTimeoutMs: 20_000 }), /必须小于 reviewTimeoutMs/);
  assert.equal(parseConfig({ ...jev({ timeoutMs: 20_000, retryCount: 0 }), reviewTimeoutMs: 20_001, confirmationTimeoutMs: 89_000 }).reviewTimeoutMs, 20_001);
  // A disabled block costs nothing, so it never conflicts with the review budget.
  assert.ok(parseConfig({ ...jev({ enabled: false, timeoutMs: 30_000 }), reviewTimeoutMs: 20_000 }).jev);
});

test("the jev block survives a save/load round trip untouched", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    const config = parseConfig({ model: "test/model", jev: { confidenceThreshold: 0.92, retryCount: 0 } });
    await store.save(config);
    const loaded = await store.load();
    assert.deepEqual(loaded.jev, config.jev);
    // Toggling an unrelated switch the way the commands do must not drop the block.
    await store.save({ ...loaded, bashBypassEnabled: false });
    assert.deepEqual((await store.load()).jev, config.jev);
  } finally { await w.cleanup(); }
});


test("the prefilter state carries redacted content only", () => {
  // Synthetic token strings exercise redaction; no provider credentials are used.
  const history = [{ type: "message", message: { role: "user", content: "用 token=abcd1234secret 部署" } }];
  const payload = buildReviewPayload({ operation: call("bash", { command: "curl -H 'Authorization: Bearer sk-live-000111222333' x" }), cwd: "/work", trigger: "bash", history }, parseConfig({}));
  const state = JSON.stringify(buildJevRequest(payload).state);
  assert.ok(!state.includes("abcd1234secret"));
  assert.ok(!state.includes("sk-live-000111222333"));
  assert.match(state, /REDACTED/);
});

test("answers are accepted only in the documented Choice shape", () => {
  const ok = { model: "jev-1.13.0", answers: { [JEV_QUESTION_ID]: { type: "choice", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  assert.deepEqual(parseJevResponse(ok), { model: "jev-1.13.0", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 });
  const answer = (patch: Record<string, unknown>) => ({ ...ok, answers: { [JEV_QUESTION_ID]: { ...ok.answers[JEV_QUESTION_ID], ...patch } } });
  for (const value of [
    undefined, null, "allow", [], {}, { answers: {} }, { answers: [] }, { answers: null },
    { answers: { other_question: ok.answers[JEV_QUESTION_ID] } },
    answer({ type: "noul" }), answer({ type: undefined }),
    answer({ choice: "ask" }), answer({ choice: undefined }), answer({ choice: "Allow" }),
    answer({ probabilities: { allow: 1 } }), answer({ probabilities: { allow: 0.9, deny: 0.1, ask: 0 } }),
    answer({ probabilities: { allow: "0.9", deny: 0.1 } }), answer({ probabilities: { allow: 1.4, deny: 0.1 } }),
    answer({ probabilities: { allow: -0.1, deny: 1 } }), answer({ probabilities: { allow: Number.NaN, deny: 1 } }),
    answer({ probabilities: [0.9, 0.1] }), answer({ probabilities: undefined }),
    answer({ confidence: undefined }), answer({ confidence: 1.2 }), answer({ confidence: "0.8" }),
    // choice must be the highest-probability option, as documented.
    answer({ choice: "allow", probabilities: { allow: 0.2, deny: 0.8 } }),
  ]) assert.throws(() => parseJevResponse(value), ReviewAttemptError);
  // A missing or implausible model field degrades to undefined rather than failing the call.
  assert.equal(parseJevResponse({ ...ok, model: undefined }).model, undefined);
  assert.equal(parseJevResponse({ ...ok, model: "../../etc/passwd" }).model, undefined);
  assert.equal(parseJevResponse({ ...ok, model: "jev\u001b[31m" }).model, undefined);
  assert.equal(parseJevResponse(answer({ choice: "deny", probabilities: { allow: 0.1, deny: 0.9 } })).choice, "deny");
});

test("the gate thresholds the winning option's probability and honours the 0.5 confidence floor", () => {
  const gate = (allow: number, deny: number, confidence: number, threshold = 0.85) =>
    gateJevAnswer({ choice: allow >= deny ? "allow" : "deny", probabilities: { allow, deny }, confidence }, threshold);
  const trusted = gate(0.93, 0.07, 0.88);
  assert.deepEqual(trusted, { decision: "allow", probability: 0.93, confidence: 0.88, threshold: 0.85, trusted: true });
  assert.equal(gate(0.05, 0.95, 0.9).decision, "deny");
  assert.equal(gate(0.05, 0.95, 0.9).probability, 0.95);
  assert.equal(gate(0.05, 0.95, 0.9).trusted, true);
  // Exactly at the threshold is trusted; a hair below is not.
  assert.equal(gate(0.85, 0.15, 0.9).trusted, true);
  assert.equal(gate(0.8499, 0.1501, 0.99).trusted, false);
  // A flat distribution is the documented way for a judgment model to say "I cannot tell".
  assert.equal(gate(0.52, 0.48, 0.1).trusted, false);
  // High winning probability with sub-floor confidence still escalates.
  assert.equal(gate(0.99, 0.01, 0.49).trusted, false);
  assert.equal(gate(0.99, 0.01, 0.5).trusted, true);
  assert.equal(gate(0.9, 0.1, 0.9, 1).trusted, false);
  assert.equal(gate(1, 0, 1, 1).trusted, true);
});

test("verdicts are composed locally, only for trusted gates, and carry no model text", () => {
  const allow = jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 }, 0.85), "typesafe/jev-1.13.0");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.source, "prefilter");
  assert.equal(allow.recommendation, undefined);
  // jev grades no risk and no authorization, so neither is claimed.
  assert.equal(allow.risk, undefined);
  assert.equal(allow.authorization, undefined);
  assert.equal(allow.reason, "前置审查（typesafe/jev-1.13.0）判定可放行：胜出概率 0.93 ≥ 阈值 0.85（confidence 0.88）");
  const deny = jevVerdict(gateJevAnswer({ choice: "deny", probabilities: { allow: 0.02, deny: 0.98 }, confidence: 0.97 }, 0.9), "typesafe/jev-1.13.0");
  assert.equal(deny.decision, "deny");
  assert.match(deny.reason, /判定应拒绝：胜出概率 0\.98 ≥ 阈值 0\.9（confidence 0\.97）/);
  // A fine-grained threshold keeps its precision instead of rounding to two places.
  assert.match(jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.6, deny: 0.4 }, confidence: 0.7 }, 0.5001), "typesafe/jev-latest").reason, /阈值 0\.5001/);
  // Terminal control sequences in a model name cannot reach the confirmation dialog.
  assert.ok(!jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 1, deny: 0 }, confidence: 1 }, 0.85), "jev\u001b[31m").reason.includes("\u001b"));
  assert.throws(() => jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.6, deny: 0.4 }, confidence: 0.6 }, 0.85), "typesafe/jev-latest"), /置信度不足/);
});

test("attempt labels carry the full candidate identifier under the jev: prefix", () => {
  assert.equal(jevAttemptModel("typesafe/jev-latest"), "jev:typesafe/jev-latest");
  assert.equal(jevAttemptModel(fakeCandidate(async () => ({}), "other/jev-canary")), "jev:other/jev-canary");
});


/** A fake native judgment: the SDK shape, answered locally with no transport involved. */
type FakeJudge = (request: JudgmentRequest, options?: JudgeOptions) => Promise<unknown>;
const fakeCandidate = (impl: FakeJudge, model = "test-jev/jev-latest"): JevCandidate => ({ model, judge: impl as unknown as JevCandidate["judge"] });

const judgeResult = (choice: "allow" | "deny", allow: number, deny: number, confidence: number, model = "jev-1.13.0") =>
  ({ model, answers: { [JEV_QUESTION_ID]: { type: "choice", choice, probabilities: { allow, deny }, confidence } } });

/** A judge that only ever settles when its attempt is aborted. */
const slowCandidate = () => fakeCandidate((_request, options) => new Promise<never>((_resolve, reject) => {
  options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
}));

const payloadFor = (command = "npm test") => buildReviewPayload(
  { operation: call("bash", { command }), cwd: "/work", trigger: "bash", history: userHistory },
  parseConfig({}),
);

const jevConfig = (extra: Partial<JevConfig> = {}): JevConfig =>
  ({ ...jevDefaults, timeoutMs: 1_000, retryCount: 1, retryDelayMs: 5, ...extra });

test("a native candidate's answer gates the review and reports its versioned id", async () => {
  const payload = payloadFor();
  const seen: { request: JudgmentRequest; hadSignal: boolean }[] = [];
  const candidate = fakeCandidate(async (request, options) => {
    seen.push({ request, hadSignal: options?.signal instanceof AbortSignal });
    return judgeResult("allow", 0.93, 0.07, 0.88);
  });
  const attempts: ReviewAttempt[] = [];
  const outcome = await reviewWithJev(payload, jevConfig(), [candidate], 10_000, new AbortController().signal, a => attempts.push({ ...a }));
  assert.equal(seen.length, 1);
  // The judge receives the redacted payload as the state and a live abort signal.
  assert.equal(seen[0].request.state, payload);
  assert.equal(seen[0].hadSignal, true);
  // The versioned id that answered is reported under the candidate's provider, not the alias.
  assert.equal(outcome!.model, "test-jev/jev-1.13.0");
  assert.deepEqual(outcome!.gate, { decision: "allow", probability: 0.93, confidence: 0.88, threshold: 0.85, trusted: true });
  assert.deepEqual(attempts.map(a => [a.model, a.status]), [["jev:test-jev/jev-latest", "running"], ["jev:test-jev/jev-latest", "success"]]);
});

test("an answer below the threshold is returned untrusted rather than as a failure", async () => {
  let calls = 0;
  const candidate = fakeCandidate(async () => { calls++; return judgeResult("deny", 0.41, 0.59, 0.33); });
  const attempts: ReviewAttempt[] = [];
  const outcome = await reviewWithJev(payloadFor("rm -rf /"), jevConfig(), [candidate], 10_000, new AbortController().signal, a => attempts.push({ ...a }));
  assert.equal(outcome!.gate.trusted, false);
  assert.equal(outcome!.gate.decision, "deny");
  // Low confidence is a valid answer, so it must not be retried or logged as an error.
  assert.equal(calls, 1);
  assert.deepEqual(attempts.map(a => a.status), ["running", "success"]);
});

test("permanent failures cost the candidate its only attempt, then degrade silently", async () => {
  for (const code of ["auth_error", "invalid_response", "output_limit"] as const) {
    let calls = 0;
    const candidate = fakeCandidate(async () => { calls++; throw new ReviewAttemptError(code); });
    const attempts: ReviewAttempt[] = [];
    const outcome = await reviewWithJev(payloadFor(), jevConfig(), [candidate], 10_000, new AbortController().signal, a => attempts.push({ ...a }));
    assert.equal(outcome, undefined, `${code} must degrade`);
    assert.equal(calls, 1, `${code} must not retry`);
    assert.equal(attempts.at(-1)!.status, code);
  }
  // A raw provider error is normalized to a fixed category; its text never reaches diagnostics.
  const candidate = fakeCandidate(async () => { throw new Error("endpoint rejected key ts-secret-value for rm -rf /"); });
  const attempts: ReviewAttempt[] = [];
  assert.equal(await reviewWithJev(payloadFor(), jevConfig(), [candidate], 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
  assert.equal(attempts.at(-1)!.status, "call_error");
  const diagnostics = formatAttempts(attempts);
  assert.ok(!diagnostics.includes("ts-secret-value"));
  assert.ok(!diagnostics.includes("rm -rf"));
});

test("transient failures are retried with backoff and a later success still wins", async () => {
  let calls = 0;
  const flaky = fakeCandidate(async () => {
    calls++;
    if (calls === 1) throw new ReviewAttemptError("rate_limit");
    return judgeResult("allow", 0.93, 0.07, 0.88);
  });
  const attempts: ReviewAttempt[] = [];
  const outcome = await reviewWithJev(payloadFor(), jevConfig(), [flaky], 10_000, new AbortController().signal, a => attempts.push({ ...a }));
  assert.equal(outcome!.gate.trusted, true);
  assert.equal(calls, 2);
  assert.deepEqual(attempts.map(a => [a.attempt, a.status]), [[1, "running"], [1, "rate_limit"], [2, "running"], [2, "success"]]);

  let exhausted = 0;
  const down = fakeCandidate(async () => { exhausted++; throw new ReviewAttemptError("call_error"); });
  const retryAttempts: ReviewAttempt[] = [];
  assert.equal(await reviewWithJev(payloadFor(), jevConfig(), [down], 10_000, new AbortController().signal, a => retryAttempts.push({ ...a })), undefined);
  // retryCount 1 means two attempts in total, then degradation.
  assert.equal(exhausted, 2);
  assert.deepEqual(retryAttempts.filter(a => a.status !== "running").map(a => a.status), ["call_error", "call_error"]);
});

test("malformed answers degrade without retrying", async () => {
  for (const result of [
    { answers: { other: { type: "choice" } } },
    // choice is not the highest-probability option, as documented.
    judgeResult("allow", 0.4, 0.6, 0.9),
    { model: "jev-1.13.0", answers: { [JEV_QUESTION_ID]: { type: "noul", noul: 0.9 } } },
    null,
  ]) {
    let calls = 0;
    const candidate = fakeCandidate(async () => { calls++; return result; });
    const attempts: ReviewAttempt[] = [];
    assert.equal(await reviewWithJev(payloadFor(), jevConfig(), [candidate], 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
    assert.equal(attempts.at(-1)!.status, "invalid_response");
    assert.equal(calls, 1);
  }
});

test("a slow judge is abandoned at the per-attempt timeout", async () => {
  const attempts: ReviewAttempt[] = [];
  const started = Date.now();
  assert.equal(await reviewWithJev(payloadFor(), jevConfig({ timeoutMs: 60, retryCount: 0 }), [slowCandidate()], 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
  assert.ok(Date.now() - started < 1_500, "must not wait for the slow judgment");
  assert.equal(attempts.at(-1)!.status, "timeout");
});

test("cancellation propagates instead of degrading to the LLM chain", async () => {
  const controller = new AbortController();
  const pending = reviewWithJev(payloadFor(), jevConfig(), [slowCandidate()], 10_000, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /取消/);
});

test("no candidates means no attempt and no diagnostics, just degradation", async () => {
  const attempts: ReviewAttempt[] = [];
  assert.equal(await reviewWithJev(payloadFor(), jevConfig(), [], 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
  // Nothing was attempted, so nothing is reported as a failure either.
  assert.equal(attempts.length, 0);
});

test("a budget smaller than one attempt skips the prefilter", async () => {
  let calls = 0;
  const candidate = fakeCandidate(async () => { calls++; return judgeResult("allow", 0.93, 0.07, 0.88); });
  assert.equal(await reviewWithJev(payloadFor(), jevConfig(), [candidate], 0, new AbortController().signal), undefined);
  assert.equal(calls, 0);
});

test("candidates are tried in order and the answering candidate's provider prefixes the version", async () => {
  const down = fakeCandidate(async () => { throw new ReviewAttemptError("auth_error"); }, "test-jev/jev-latest");
  const up = fakeCandidate(async () => judgeResult("deny", 0.02, 0.98, 0.96), "other/jev-canary");
  const attempts: ReviewAttempt[] = [];
  const outcome = await reviewWithJev(payloadFor(), jevConfig(), [down, up], 10_000, new AbortController().signal, a => attempts.push({ ...a }));
  assert.equal(outcome!.model, "other/jev-1.13.0");
  assert.equal(outcome!.gate.decision, "deny");
  assert.equal(outcome!.gate.trusted, true);
  assert.deepEqual(attempts.filter(a => a.status !== "running").map(a => [a.model, a.status]), [["jev:test-jev/jev-latest", "auth_error"], ["jev:other/jev-canary", "success"]]);
});

test("a missing or implausible version id falls back to the candidate model", async () => {
  for (const result of [
    // No model field at all in the judgment result.
    { answers: { [JEV_QUESTION_ID]: { type: "choice", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 } } },
    judgeResult("allow", 0.93, 0.07, 0.88, "../../etc/passwd"),
  ]) {
    const outcome = await reviewWithJev(payloadFor(), jevConfig(), [fakeCandidate(async () => result)], 10_000, new AbortController().signal);
    assert.equal(outcome!.model, "test-jev/jev-latest");
  }
});


test("the shipped example configuration is valid and matches the documented defaults", async () => {
  // A broken example would be copied straight into a user configuration, so it is checked here.
  const example = JSON.parse(await readFile(new URL("../examples/auto-review.json", import.meta.url), "utf8"));
  const parsed = parseConfig(example);
  assert.deepEqual(parsed.jev, { ...jevDefaults });
  // The example must also satisfy the budget rule it is meant to illustrate.
  assert.ok(jevBudgetMs(parsed.jev) < parsed.reviewTimeoutMs);
  assert.ok(parsed.reviewTimeoutMs + parsed.confirmationTimeoutMs <= 110_000);
});
