import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { JudgeOptions, JudgmentRequest } from "@oh-my-pi/pi-ai/judgment";
import { appendAudit, type AuditRecord } from "../src/audit.ts";
import { defaults, type JevConfig, type ReviewConfig } from "../src/config.ts";
import { ReviewEngine } from "../src/engine.ts";
import { JEV_QUESTION_ID, type JevCandidate } from "../src/jev.ts";
import type { ReviewLogRecord } from "../src/review-log.ts";
import { prefilterChain, type LlmReviewer } from "../src/chain.ts";
import type { ReviewResult } from "../src/status.ts";
import { reviewStatus } from "../src/status.ts";
import type { Verdict } from "../src/reviewer.ts";
import { ReviewAttemptError } from "../src/attempt.ts";
import { builtin, call, context, userHistory, workspace } from "./helpers.ts";

/** A fake native judgment candidate: the SDK shape, answered locally with no transport involved. */
type FakeJudge = (request: JudgmentRequest, options?: JudgeOptions) => Promise<unknown>;
const fakeCandidate = (impl: FakeJudge, model = "test-jev/jev-latest"): JevCandidate => ({ model, judge: impl as unknown as JevCandidate["judge"] });

const judgeResult = (choice: "allow" | "deny", allow: number, deny: number, confidence: number, model = "jev-1.13.0") =>
  ({ model, answers: { [JEV_QUESTION_ID]: { type: "choice", choice, probabilities: { allow, deny }, confidence } } });

/** A candidate whose every judgment is recorded and answered with the given choice. */
const answering = (choice: "allow" | "deny", allow: number, deny: number, confidence: number) => {
  const calls: JudgmentRequest[] = [];
  return { calls, candidate: fakeCandidate(async request => { calls.push(request); return judgeResult(choice, allow, deny, confidence); }) };
};

/** A candidate that only ever settles when its attempt is aborted. */
const slowCandidate = () => fakeCandidate((_request, options) => new Promise<never>((_resolve, reject) => {
  options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
}));

const jevBlock = (extra: Partial<JevConfig> = {}): JevConfig => ({
  enabled: true, confidenceThreshold: 0.85, timeoutMs: 1_000, retryCount: 0, retryDelayMs: 0, ...extra,
});

const llmVerdict: Verdict = { decision: "allow", risk: "low", authorization: "implicit", reason: "LLM 认为属于任务范围" };

/** An observable LLM layer: every handover to the slower reviewer is counted, no provider SDK involved. */
const fakeLlm = (counter: { calls: number; budgets: number[] }, llm: () => Verdict = () => llmVerdict): LlmReviewer =>
  async (content, _request, _config, _ctx, _signal, onAttempt, budgetMs) => {
    counter.calls++;
    counter.budgets.push(budgetMs);
    // The LLM layer receives the same redacted payload, serialized.
    assert.match(content, /"latestUserInstruction"/);
    onAttempt?.({ model: "test/reviewer", status: "success", elapsedMs: 1 });
    return { ...llm(), reviewerModel: "test/reviewer" };
  };

/** The real chain with the LLM layer and the host candidate pool both injected. */
const chainWithFakeLlm = (counter: { calls: number; budgets: number[] }, candidates: readonly JevCandidate[], llm?: () => Verdict) =>
  prefilterChain(fakeLlm(counter, llm), () => candidates);

/** The prefilter-only chain: an escalation has nowhere to go and must be reported as such. */
const jevOnlyChain = (candidates: readonly JevCandidate[]) => prefilterChain(async () => { throw new Error("LLM 层不应被调用"); }, () => candidates);

test("a confident allow is decided by the prefilter alone, with no LLM call", async () => {
  const judge = answering("allow", 0.95, 0.05, 0.9);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock() };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const statuses: ReviewResult[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, [judge.candidate]),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
      onResult: (_operation, result) => { statuses.push(result); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(counter.calls, 0, "a trusted prefilter verdict must not reach the LLM chain");
    assert.equal(judge.calls.length, 1);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].outcome, "allowed");
    // The audit names the versioned model that actually answered.
    assert.equal(records[0].model, "jev:test-jev/jev-1.13.0");
    assert.deepEqual(records[0].prefilter, {
      model: "test-jev/jev-1.13.0", decision: "allow", probability: 0.95, confidence: 0.9,
      threshold: 0.85, trusted: true, status: "decided", elapsedMs: records[0].prefilter!.elapsedMs,
    });
    assert.equal(records[0].fallbackUsed, undefined);
    assert.match(records[0].reason, /前置审查（test-jev\/jev-1\.13\.0）判定可放行：胜出概率 0\.95 ≥ 阈值 0\.85/);
    assert.deepEqual(records[0].attempts!.map(a => [a.model, a.status]), [["jev:test-jev/jev-latest", "success"]]);
    assert.equal(logs[0].prefilter!.status, "decided");
    assert.equal(statuses[0].prefilter!.trusted, true);
  } finally { await w.cleanup(); }
});

test("a confident deny blocks immediately, without asking a human", async () => {
  const judge = answering("deny", 0.02, 0.98, 0.96);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock() };
    const records: AuditRecord[] = [];
    const statuses: ReviewResult[] = [];
    let dialogs = 0;
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, [judge.candidate]),
      audit: async record => { records.push(record); },
      onResult: (_operation, result) => { statuses.push(result); },
    });
    // A TUI is available, so a confirmation window would be offered if one were wanted.
    const { ctx } = context(w.cwd, async () => { dialogs++; return "仅批准本次调用"; });
    const result = await engine.handle(call("bash", { command: "rm -rf /etc" }), ctx);
    assert.equal(result?.block, true);
    // A trusted answer is final: no confirmation window or human override.
    assert.equal(dialogs, 0, "a trusted prefilter deny must not open a confirmation window");
    assert.equal(counter.calls, 0);
    assert.equal(records[0].decision, "deny");
    assert.equal(records[0].outcome, "blocked");
    assert.equal(records[0].humanOverride, false);
    assert.equal(records[0].automaticRecommendation, undefined);
    assert.equal(records[0].prefilter!.decision, "deny");
    assert.equal(records[0].prefilter!.trusted, true);
    // The blocked call reports the locally composed reason back to the agent.
    assert.match(result!.reason!, /前置审查（test-jev\/jev-1\.13\.0）判定应拒绝：胜出概率 0\.98 ≥ 阈值 0\.85/);
    assert.match(reviewStatus(call("bash", { command: "rm -rf /etc" }), statuses[0]), /^审核拒绝（jev 前置）/);
  } finally { await w.cleanup(); }
});

test("an uncertain deny still gets the human window the LLM chain would give it", async () => {
  // Below the threshold the prefilter does not decide, so the escalated verdict keeps the window.
  const judge = answering("deny", 0.3, 0.7, 0.4);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock() };
    const records: AuditRecord[] = [];
    let dialog = "";
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, [judge.candidate], () => ({ decision: "deny", risk: "high", authorization: "none", reason: "LLM 判定越权" })),
      audit: async record => { records.push(record); },
    });
    const { ctx } = context(w.cwd, async title => { dialog = String(title); return undefined; });
    assert.equal((await engine.handle(call("bash", { command: "rm -rf /etc" }), ctx))?.block, true);
    assert.equal(counter.calls, 1);
    assert.equal(records[0].prefilter!.trusted, false);
    assert.match(dialog, /审核模型：test\/reviewer/);
    assert.ok(!dialog.includes("（备用）"));
    assert.match(dialog, /LLM 判定越权/);
  } finally { await w.cleanup(); }
});

test("an uncertain answer escalates to the LLM chain, which owns the verdict", async () => {
  const judge = answering("deny", 0.45, 0.55, 0.2);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock() };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, [judge.candidate]),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm run deploy" }), context(w.cwd).ctx), undefined);
    assert.equal(judge.calls.length, 1);
    assert.equal(counter.calls, 1, "an untrusted answer must reach the LLM chain");
    // The prefilter is recorded as escalated, and the LLM owns the decision and the reason.
    assert.equal(records[0].prefilter!.status, "escalated");
    assert.equal(records[0].prefilter!.trusted, false);
    assert.equal(records[0].prefilter!.probability, 0.55);
    assert.equal(records[0].prefilter!.confidence, 0.2);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].reason, "LLM 认为属于任务范围");
    assert.equal(records[0].model, "test/reviewer");
    assert.equal(records[0].preflightError, undefined);
    assert.equal(logs[0].prefilter!.status, "escalated");
  } finally { await w.cleanup(); }
});

test("prefilter failures degrade to the LLM chain and keep their diagnostics", async () => {
  for (const code of ["auth_error", "call_error"] as const) {
    let judgeCalls = 0;
    const candidate = fakeCandidate(async () => { judgeCalls++; throw new ReviewAttemptError(code); });
    const w = await workspace();
    try {
      const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock() };
      const records: AuditRecord[] = [];
      const counter = { calls: 0, budgets: [] as number[] };
      const engine = new ReviewEngine({
        config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
        review: chainWithFakeLlm(counter, [candidate]),
        audit: async record => { records.push(record); },
      });
      assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
      assert.equal(counter.calls, 1, `${code} must degrade to the LLM chain`);
      assert.equal(records[0].decision, "allow");
      assert.equal(records[0].prefilter!.status, "unavailable");
      assert.equal(records[0].prefilter!.trusted, false);
      assert.equal(records[0].prefilter!.decision, undefined);
      assert.equal(records[0].prefilter!.probability, undefined);
      // Both layers keep their own diagnostics in one attempts list.
      assert.deepEqual(records[0].attempts!.map(a => [a.model, a.status]), [["jev:test-jev/jev-latest", code], ["test/reviewer", "success"]]);
      assert.equal(records[0].model, "test/reviewer");
    } finally { await w.cleanup(); }
  }
});

test("an empty candidate pool leaves no prefilter trace and hands the LLM the full budget", async () => {
  const w = await workspace();
  try {
    // The selector returned no available native judge, so the prefilter is absent.
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock() };
    const records: AuditRecord[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, []),
      audit: async record => { records.push(record); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(counter.calls, 1);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].prefilter, undefined, "no candidate, no prefilter record");
    assert.deepEqual(records[0].attempts!.map(a => [a.model, a.status]), [["test/reviewer", "success"]]);
    assert.equal(records[0].model, "test/reviewer");
    // No prefilter time was spent, so the LLM chain keeps the whole review budget.
    assert.ok(counter.budgets[0] >= config.reviewTimeoutMs - 10, `LLM budget should be ~full, got ${counter.budgets[0]}`);
  } finally { await w.cleanup(); }
});

test("an enabled prefilter with no candidates fails closed when no LLM exists", async () => {
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, jev: jevBlock() };
    const records: AuditRecord[] = [];
    let selectorCalls = 0;
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain([]),
      audit: async record => { records.push(record); },
    });
    const result = await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx);
    assert.equal(result?.block, true);
    assert.match(result!.reason!, /审核模型未配置或配置无效/);
    assert.equal(records[0].preflightError, "model_not_configured");
    assert.equal(records[0].prefilter, undefined, "no candidate, no prefilter record");
    assert.equal(records[0].attempts, undefined, "no candidate, no fabricated attempt");
    assert.equal(records[0].model, null);
  } finally { await w.cleanup(); }
});

test("a jev-only setup decides on its own and logs the review", async () => {
  const judge = answering("allow", 0.95, 0.05, 0.9);
  const w = await workspace();
  try {
    // No LLM model at all: the prefilter is the only reviewer.
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock() };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain([judge.candidate]),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].model, "jev:test-jev/jev-1.13.0");
    assert.equal(records[0].preflightError, undefined);
    // The optional review log is written for a jev-only setup too.
    assert.equal(logs.length, 1);
    assert.equal(logs[0].prefilter!.status, "decided");
  } finally { await w.cleanup(); }
});

test("an uncertain jev-only answer becomes prefilter_low_confidence and needs a human", async () => {
  const judge = answering("allow", 0.6, 0.4, 0.3);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock() };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const statuses: ReviewResult[] = [];
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain([judge.candidate]),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
      onResult: (_operation, result) => { statuses.push(result); },
    });
    const result = await engine.handle(call("bash", { command: "npm run deploy" }), context(w.cwd).ctx);
    // Without a slower reviewer and without confidence, this is a human decision.
    assert.equal(result?.block, true);
    assert.match(result!.reason!, /前置审查置信度不足且未配置 LLM 审核模型/);
    assert.equal(records[0].decision, "error");
    assert.equal(records[0].preflightError, "prefilter_low_confidence");
    assert.equal(records[0].prefilter!.status, "escalated");
    // The jev attempt is real, so it is kept rather than reported as "never called".
    assert.deepEqual(records[0].attempts!.map(a => a.status), ["success"]);
    assert.equal(records[0].model, "jev:test-jev/jev-latest");
    assert.equal(statuses[0].preflightError, "prefilter_low_confidence");
    assert.equal(logs[0].preflightError, "prefilter_low_confidence");
  } finally { await w.cleanup(); }
});

test("a disabled or absent jev block leaves the LLM-only path untouched", async () => {
  const w = await workspace();
  try {
    for (const jev of [undefined, jevBlock({ enabled: false })]) {
      const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, ...(jev ? { jev } : {}) };
      const records: AuditRecord[] = [];
      const counter = { calls: 0, budgets: [] as number[] };
      let selectorCalls = 0;
      const engine = new ReviewEngine({
        config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
        review: prefilterChain(fakeLlm(counter), () => { selectorCalls++; return []; }),
        audit: async record => { records.push(record); },
      });
      assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
      assert.equal(counter.calls, 1);
      assert.equal(selectorCalls, 0, "a disabled prefilter never queries the host pool");
      assert.equal(records[0].prefilter, undefined);
    }
  } finally { await w.cleanup(); }
});

test("the prefilter shares the review budget instead of extending it", async () => {
  const w = await workspace();
  try {
    // 300ms review budget with a 150ms prefilter attempt: the LLM chain keeps the rest.
    const config: ReviewConfig = {
      ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewTimeoutMs: 300, confirmationTimeoutMs: 1_000,
      jev: jevBlock({ timeoutMs: 150, retryCount: 0 }),
    };
    const spent: number[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const chain = chainWithFakeLlm(counter, [slowCandidate()]);
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: async (request, settings, ctx, signal, onAttempt, onPrefilter) => {
        const started = Date.now();
        const verdict = await chain(request, settings, ctx, signal, onAttempt, onPrefilter);
        spent.push(Date.now() - started);
        return verdict;
      },
      audit: async () => {},
    });
    const started = Date.now();
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(counter.calls, 1, "a timed-out prefilter must hand over to the LLM chain");
    // The prefilter costs its own timeout, and the LLM inherits only the remaining budget.
    assert.ok(spent[0] >= 140, `the prefilter should consume its timeout, took ${spent[0]}ms`);
    assert.ok(counter.budgets[0] <= 300 - 140, `the LLM budget should be the remainder, got ${counter.budgets[0]}ms`);
    assert.ok(counter.budgets[0] > 0, "the LLM chain must still get time");
    assert.ok(Date.now() - started < 300, `the review must stay inside its budget, took ${Date.now() - started}ms`);
  } finally { await w.cleanup(); }
});

test("an aborted signal never reaches the LLM chain, whatever the prefilter state", async () => {
  for (const setup of [
    { jev: undefined, candidates: [answering("allow", 0.95, 0.05, 0.9).candidate] },
    { jev: jevBlock({ enabled: false }), candidates: [answering("allow", 0.95, 0.05, 0.9).candidate] },
    { jev: jevBlock(), candidates: [] },
    { jev: jevBlock(), candidates: [answering("allow", 0.95, 0.05, 0.9).candidate] },
  ]) {
    const counter = { calls: 0, budgets: [] as number[] };
    const chain = chainWithFakeLlm(counter, setup.candidates);
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", ...(setup.jev ? { jev: setup.jev } : {}) };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      chain({ operation: call("bash", { command: "npm test" }), cwd: "/work", trigger: "bash", history: userHistory }, config, context("/work").ctx, controller.signal),
      /取消/,
    );
    assert.equal(counter.calls, 0, "an aborted review must not continue into the LLM chain");
  }
});

test("cancelling mid-judgment escalates nothing: the LLM chain stays uncalled", async () => {
  const counter = { calls: 0, budgets: [] as number[] };
  const chain = chainWithFakeLlm(counter, [slowCandidate()]);
  const config: ReviewConfig = { ...defaults, model: "test/reviewer", jev: jevBlock() };
  const controller = new AbortController();
  const pending = chain({ operation: call("bash", { command: "npm test" }), cwd: "/work", trigger: "bash", history: userHistory }, config, context("/work").ctx, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /取消/);
  assert.equal(counter.calls, 0);
});


test("the audit file records the prefilter numbers and stays redacted", async () => {
  const judge = answering("allow", 0.95, 0.05, 0.9);
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, jev: jevBlock() };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain([judge.candidate]),
      audit: record => appendAudit(w.root, record),
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test", token: "hidden" }), context(w.cwd).ctx), undefined);
    // The judge saw the same redacted state the LLM chain would have seen.
    assert.ok(!JSON.stringify(judge.calls[0].state).includes("hidden"));
    const dir = join(w.root, "auto-review", "audit");
    const written = JSON.parse((await readFile(join(dir, (await readdir(dir))[0]), "utf8")).trim());
    assert.deepEqual(written.prefilter, {
      model: "test-jev/jev-1.13.0", decision: "allow", probability: 0.95, confidence: 0.9,
      threshold: 0.85, trusted: true, status: "decided", elapsedMs: written.prefilter.elapsedMs,
    });
    assert.equal(written.model, "jev:test-jev/jev-1.13.0");
    assert.equal(written.decision, "allow");
    assert.ok(!JSON.stringify(written).includes("hidden"));
  } finally { await w.cleanup(); }
});
