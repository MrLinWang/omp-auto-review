import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { appendAudit, type AuditRecord } from "../src/audit.ts";
import { defaults, type JevConfig, type ReviewConfig } from "../src/config.ts";
import { ReviewEngine } from "../src/engine.ts";
import { JEV_QUESTION_ID } from "../src/jev.ts";
import type { ReviewLogRecord } from "../src/review-log.ts";
import { prefilterChain, type LlmReviewer } from "../src/chain.ts";
import type { ReviewResult } from "../src/status.ts";
import { reviewStatus } from "../src/status.ts";
import type { Verdict } from "../src/reviewer.ts";
import { builtin, call, context, userHistory, workspace } from "./helpers.ts";

interface Reply { status?: number; body?: string; delayMs?: number }

/** Local stand-in for the TypeSafe endpoint; `requests` proves whether the prefilter ran. */
async function prefilterServer(reply: (index: number) => Reply) {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const current = reply(requests.length - 1);
      const send = () => {
        res.writeHead(current.status ?? 200, { "content-type": "application/json" });
        res.end(current.body ?? choiceBody("allow", 0.95, 0.05, 0.9));
      };
      if (current.delayMs) setTimeout(send, current.delayMs); else send();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const choiceBody = (choice: "allow" | "deny", allow: number, deny: number, confidence: number) =>
  JSON.stringify({ model: "jev-1.13.0", answers: { [JEV_QUESTION_ID]: { type: "choice", choice, probabilities: { allow, deny }, confidence } }, usage: {} });

const jevBlock = (baseUrl: string, extra: Partial<JevConfig> = {}): JevConfig => ({
  enabled: true, baseUrl, model: "jev-latest", apiKeyEnv: "OMP_REVIEW_UNSET_KEY", apiKey: "ts-secret-value",
  confidenceThreshold: 0.85, timeoutMs: 1_000, retryCount: 0, retryDelayMs: 0, ...extra,
});

const llmVerdict: Verdict = { decision: "allow", risk: "low", authorization: "implicit", reason: "LLM 认为属于任务范围" };

/**
 * The real chain with the LLM layer injected, so every handover to the slower reviewer is
 * observable and no provider SDK is involved.
 */
function chainWithFakeLlm(counter: { calls: number; budgets: number[] }, llm: () => Verdict = () => llmVerdict) {
  const fake: LlmReviewer = async (content, _request, _config, _ctx, _signal, onAttempt, budgetMs) => {
    counter.calls++;
    counter.budgets.push(budgetMs);
    // The LLM layer receives the same redacted payload, serialized.
    assert.match(content, /"latestUserInstruction"/);
    onAttempt?.({ model: "test/reviewer", status: "success", elapsedMs: 1 });
    return { ...llm(), reviewerModel: "test/reviewer" };
  };
  return prefilterChain(fake);
}

/** The prefilter-only chain: an escalation has nowhere to go and must be reported as such. */
const jevOnlyChain = prefilterChain(async () => { throw new Error("LLM 层不应被调用"); });

test("a confident allow is decided by the prefilter alone, with no LLM call", async () => {
  const server = await prefilterServer(() => ({}));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const statuses: ReviewResult[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
      onResult: (_operation, result) => { statuses.push(result); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(counter.calls, 0, "a trusted prefilter verdict must not reach the LLM chain");
    assert.equal(server.requests.length, 1);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].outcome, "allowed");
    // The audit names the versioned model that actually answered.
    assert.equal(records[0].model, "jev:jev-1.13.0");
    assert.deepEqual(records[0].prefilter, {
      model: "jev-1.13.0", decision: "allow", probability: 0.95, confidence: 0.9,
      threshold: 0.85, trusted: true, status: "decided", elapsedMs: records[0].prefilter!.elapsedMs,
    });
    assert.equal(records[0].fallbackUsed, undefined);
    assert.match(records[0].reason, /前置审查（jev-1\.13\.0）判定可放行：胜出概率 0\.95 ≥ 阈值 0\.85/);
    assert.deepEqual(records[0].attempts!.map(a => [a.model, a.status]), [["jev:jev-latest", "success"]]);
    assert.equal(logs[0].prefilter!.status, "decided");
    assert.equal(statuses[0].prefilter!.trusted, true);
    // The key must never reach the audit or the review log.
    assert.ok(!JSON.stringify([records, logs]).includes("ts-secret-value"));
  } finally { await w.cleanup(); await server.close(); }
});

test("a confident deny blocks immediately, without asking a human", async () => {
  const server = await prefilterServer(() => ({ body: choiceBody("deny", 0.02, 0.98, 0.96) }));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    const statuses: ReviewResult[] = [];
    let dialogs = 0;
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter),
      audit: async record => { records.push(record); },
      onResult: (_operation, result) => { statuses.push(result); },
    });
    // A TUI is available, so a confirmation window would be offered if one were wanted.
    const { ctx } = context(w.cwd, async () => { dialogs++; return "仅批准本次调用"; });
    const result = await engine.handle(call("bash", { command: "rm -rf /etc" }), ctx);
    assert.equal(result?.block, true);
    // Inside the threshold jev's choice is executed as-is: no window, no human override.
    assert.equal(dialogs, 0, "a trusted prefilter deny must not open a confirmation window");
    assert.equal(counter.calls, 0);
    assert.equal(records[0].decision, "deny");
    assert.equal(records[0].outcome, "blocked");
    assert.equal(records[0].humanOverride, false);
    assert.equal(records[0].automaticRecommendation, undefined);
    assert.equal(records[0].prefilter!.decision, "deny");
    assert.equal(records[0].prefilter!.trusted, true);
    // The blocked call reports the locally composed reason back to the agent.
    assert.match(result!.reason!, /前置审查（jev-1\.13\.0）判定应拒绝：胜出概率 0\.98 ≥ 阈值 0\.85/);
    assert.match(reviewStatus(call("bash", { command: "rm -rf /etc" }), statuses[0]), /^审核拒绝（jev 前置）/);
  } finally { await w.cleanup(); await server.close(); }
});

test("an uncertain deny still gets the human window the LLM chain would give it", async () => {
  // Below the threshold the prefilter does not decide, so the escalated verdict keeps the window.
  const server = await prefilterServer(() => ({ body: choiceBody("deny", 0.3, 0.7, 0.4) }));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    let dialog = "";
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter, () => ({ decision: "deny", risk: "high", authorization: "none", reason: "LLM 判定越权" })),
      audit: async record => { records.push(record); },
    });
    const { ctx } = context(w.cwd, async title => { dialog = String(title); return undefined; });
    assert.equal((await engine.handle(call("bash", { command: "rm -rf /etc" }), ctx))?.block, true);
    assert.equal(counter.calls, 1);
    assert.equal(records[0].prefilter!.trusted, false);
    assert.match(dialog, /审核模型：test\/reviewer/);
    assert.ok(!dialog.includes("（备用）"));
    assert.match(dialog, /LLM 判定越权/);
  } finally { await w.cleanup(); await server.close(); }
});

test("an uncertain answer escalates to the LLM chain, which owns the verdict", async () => {
  const server = await prefilterServer(() => ({ body: choiceBody("deny", 0.45, 0.55, 0.2) }));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: chainWithFakeLlm(counter),
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm run deploy" }), context(w.cwd).ctx), undefined);
    assert.equal(server.requests.length, 1);
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
  } finally { await w.cleanup(); await server.close(); }
});

test("prefilter failures degrade to the LLM chain and keep their diagnostics", async () => {
  for (const [status, expected] of [[401, "auth_error"], [500, "call_error"]] as const) {
    const server = await prefilterServer(() => ({ status, body: "{}" }));
    const w = await workspace();
    try {
      const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, jev: jevBlock(server.baseUrl) };
      const records: AuditRecord[] = [];
      const counter = { calls: 0, budgets: [] as number[] };
      const engine = new ReviewEngine({
        config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
        review: chainWithFakeLlm(counter),
        audit: async record => { records.push(record); },
      });
      assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
      assert.equal(counter.calls, 1, `status ${status} must degrade to the LLM chain`);
      assert.equal(records[0].decision, "allow");
      assert.equal(records[0].prefilter!.status, "unavailable");
      assert.equal(records[0].prefilter!.trusted, false);
      assert.equal(records[0].prefilter!.decision, undefined);
      assert.equal(records[0].prefilter!.probability, undefined);
      // Both layers keep their own diagnostics in one attempts list.
      assert.deepEqual(records[0].attempts!.map(a => [a.model, a.status]), [["jev:jev-latest", expected], ["test/reviewer", "success"]]);
      assert.equal(records[0].model, "test/reviewer");
    } finally { await w.cleanup(); await server.close(); }
  }
});

test("a jev-only setup decides on its own and logs the review", async () => {
  const server = await prefilterServer(() => ({}));
  const w = await workspace();
  try {
    // No LLM model at all: the prefilter is the only reviewer.
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain,
      audit: async record => { records.push(record); },
      reviewLog: async (_path, record) => { logs.push(record); },
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
    assert.equal(records[0].decision, "allow");
    assert.equal(records[0].model, "jev:jev-1.13.0");
    assert.equal(records[0].preflightError, undefined);
    // The optional review log is written for a jev-only setup too.
    assert.equal(logs.length, 1);
    assert.equal(logs[0].prefilter!.status, "decided");
  } finally { await w.cleanup(); await server.close(); }
});

test("an uncertain jev-only answer becomes prefilter_low_confidence and needs a human", async () => {
  const server = await prefilterServer(() => ({ body: choiceBody("allow", 0.6, 0.4, 0.3) }));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, reviewLogPath: "reviews.jsonl", jev: jevBlock(server.baseUrl) };
    const records: AuditRecord[] = [];
    const logs: ReviewLogRecord[] = [];
    const statuses: ReviewResult[] = [];
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain,
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
    assert.equal(records[0].model, "jev:jev-latest");
    assert.equal(statuses[0].preflightError, "prefilter_low_confidence");
    assert.equal(logs[0].preflightError, "prefilter_low_confidence");
  } finally { await w.cleanup(); await server.close(); }
});

test("a disabled or absent jev block leaves the LLM-only path untouched", async () => {
  const server = await prefilterServer(() => ({}));
  const w = await workspace();
  try {
    for (const jev of [undefined, jevBlock(server.baseUrl, { enabled: false })]) {
      const config: ReviewConfig = { ...defaults, model: "test/reviewer", bashBypassEnabled: false, ...(jev ? { jev } : {}) };
      const records: AuditRecord[] = [];
      const counter = { calls: 0, budgets: [] as number[] };
      const engine = new ReviewEngine({
        config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
        review: chainWithFakeLlm(counter),
        audit: async record => { records.push(record); },
      });
      assert.equal(await engine.handle(call("bash", { command: "npm test" }), context(w.cwd).ctx), undefined);
      assert.equal(counter.calls, 1);
      assert.equal(server.requests.length, 0, "a disabled prefilter must not be contacted");
      assert.equal(records[0].prefilter, undefined);
    }
  } finally { await w.cleanup(); await server.close(); }
});

test("the prefilter shares the review budget instead of extending it", async () => {
  const server = await prefilterServer(() => ({ delayMs: 600 }));
  const w = await workspace();
  try {
    // 300ms review budget with a 150ms prefilter attempt: the LLM chain keeps the rest.
    const config: ReviewConfig = {
      ...defaults, model: "test/reviewer", bashBypassEnabled: false, reviewTimeoutMs: 300, confirmationTimeoutMs: 1_000,
      jev: jevBlock(server.baseUrl, { timeoutMs: 150, retryCount: 0 }),
    };
    const spent: number[] = [];
    const counter = { calls: 0, budgets: [] as number[] };
    const chain = chainWithFakeLlm(counter);
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
  } finally { await w.cleanup(); await server.close(); }
});


test("the audit file records the prefilter numbers and no credentials", async () => {
  const server = await prefilterServer(() => ({}));
  const w = await workspace();
  try {
    const config: ReviewConfig = { ...defaults, model: undefined, bashBypassEnabled: false, jev: jevBlock(server.baseUrl) };
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], history: () => userHistory,
      review: jevOnlyChain,
      audit: record => appendAudit(w.root, record),
    });
    assert.equal(await engine.handle(call("bash", { command: "npm test", token: "hidden" }), context(w.cwd).ctx), undefined);
    const dir = join(w.root, "auto-review", "audit");
    const written = JSON.parse((await readFile(join(dir, (await readdir(dir))[0]), "utf8")).trim());
    assert.deepEqual(written.prefilter, {
      model: "jev-1.13.0", decision: "allow", probability: 0.95, confidence: 0.9,
      threshold: 0.85, trusted: true, status: "decided", elapsedMs: written.prefilter.elapsedMs,
    });
    assert.equal(written.model, "jev:jev-1.13.0");
    assert.equal(written.decision, "allow");
    assert.ok(!JSON.stringify(written).includes("ts-secret-value"));
    assert.ok(!JSON.stringify(written).includes("hidden"));
  } finally { await w.cleanup(); await server.close(); }
});
