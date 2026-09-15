import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ReviewEngine, ConfirmationQueue, type Dependencies } from "../src/engine.ts";
import type { AuditRecord } from "../src/audit.ts";
import { defaults } from "../src/config.ts";
import type { Verdict } from "../src/reviewer.ts";
import { builtin, call, context, workspace } from "./helpers.ts";
import { reviewWithFallback } from "../src/fallback.ts";
import { ReviewAttemptError } from "../src/attempt.ts";

const allow: Verdict = { decision: "allow", risk: "low", authorization: "implicit", reason: "任务范围内" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("failed fallback chain shows and audits the last model and each failure", async () => {
  const w = await workspace();
  try {
    const f = fixture({ review: async (_request, config, _ctx, signal, observer) =>
      reviewWithFallback(["test/primary", "test/backup"], config.reviewTimeoutMs, signal, async (_model, _signal, index) => {
        throw new ReviewAttemptError(index === 0 ? "invalid_response" : "output_limit");
      }, observer),
    });
    const c = context(w.cwd, async title => {
      assert.ok(title.includes("最后尝试模型：test/backup（备用）"));
      assert.ok(title.includes("test/primary：响应格式无效"));
      assert.ok(title.includes("test/backup：输出达到上限"));
      return "拒绝执行";
    });
    assert.equal((await f.engine.handle(call(), c.ctx))?.block, true);
    assert.equal(f.records[0].model, "test/backup");
    assert.deepEqual(f.records[0].attempts?.map(attempt => attempt.status), ["invalid_response", "output_limit"]);
  } finally { await w.cleanup(); }
});

test("a retried primary is never labeled as a backup", async () => {
  const w = await workspace();
  try {
    const f = fixture({
      config: () => ({ ...defaults, model: "test/primary", reviewTimeoutMs: 500, confirmationTimeoutMs: 200 }),
      review: async (_request, config, _ctx, signal, observer) =>
        reviewWithFallback(["test/primary"], config.reviewTimeoutMs, signal, async (_model, _signal, _index, retry) => {
          if (!retry) throw new ReviewAttemptError("call_error");
          return { ...allow, decision: "ask" };
        }, observer, { retryCount: 1, retryDelayMs: 1 }),
    });
    const seen: string[] = [];
    const c = context(w.cwd, async title => { seen.push(title); return "拒绝执行"; });
    assert.equal((await f.engine.handle(call(), c.ctx))?.block, true);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes("审核模型：test/primary"), seen[0]);
    assert.ok(!seen[0].includes("（备用）"), seen[0]);
    assert.ok(!seen[0].includes("最后尝试模型"), seen[0]);
    assert.equal(f.records[0].fallbackUsed, undefined);
    assert.deepEqual(f.records[0].attempts?.map(attempt => [attempt.model, attempt.attempt, attempt.status]), [
      ["test/primary", 1, "call_error"], ["test/primary", 2, "success"],
    ]);
  } finally { await w.cleanup(); }
});

test("outer review timeout preserves diagnostics and ignores late attempt updates", async () => {
  const w = await workspace();
  try {
    const f = fixture({
      config: () => ({ ...defaults, model: "test/primary", reviewTimeoutMs: 15, confirmationTimeoutMs: 200 }),
      review: async (_request, _config, _ctx, signal, observer) =>
        reviewWithFallback(["test/primary"], 1000, signal, async () => new Promise(() => {}), observer),
    });
    assert.equal((await f.engine.handle(call(), context(w.cwd).ctx))?.block, true);
    await sleep(5);
    assert.equal(f.records[0].attempts?.[0].status, "timeout");
    assert.ok(f.records[0].reason.includes("test/primary：超时"));
  } finally { await w.cleanup(); }
});

test("recommendation timeout acts on ask only and records automatic rather than human approval", async () => {
  const w = await workspace();
  try {
    for (const action of ["approve", "deny"] as const) {
      const f = fixture({
        config: () => ({ ...defaults, model: "test/reviewer", reviewTimeoutMs: 100, confirmationTimeoutMs: 2000, recommendationTimeoutMs: 15 }),
        review: async () => ({ ...allow, decision: "ask", recommendation: { action, reason: "测试建议" } }),
      });
      const c = context(w.cwd, async title => {
        assert.ok(title.includes("0.015 秒内未选择"));
        return new Promise(() => {});
      });
      assert.equal((await f.engine.handle(call(), c.ctx))?.block, action === "approve" ? undefined : true);
      assert.equal(f.records[0].automaticRecommendation, true);
      assert.equal(f.records[0].humanOverride, false);
    }
    for (const choice of [undefined, "拒绝执行"]) {
      const f = fixture({
        config: () => ({ ...defaults, model: "test/reviewer", reviewTimeoutMs: 100, confirmationTimeoutMs: 2000, recommendationTimeoutMs: 15 }),
        review: async () => ({ ...allow, decision: "ask", recommendation: { action: "approve", reason: "测试建议" } }),
      });
      assert.equal((await f.engine.handle(call(), context(w.cwd, async () => choice).ctx))?.block, true);
      assert.equal(f.records[0].automaticRecommendation, undefined);
    }
  } finally { await w.cleanup(); }
});

test("ask recommendation is displayed and audited but requires explicit approval", async () => {
  const w = await workspace();
  try {
    for (const choice of [undefined, "拒绝执行", "仅批准本次调用"]) {
      const f = fixture({ review: async () => ({ ...allow, decision: "ask", recommendation: { action: "approve", reason: "范围已知 TOKEN=hidden" } }) });
      const c = context(w.cwd, async (title, choices, options) => {
        assert.ok(title.includes("模型推荐：建议批准本次调用"));
        assert.ok(title.includes("推荐理由：范围已知"));
        assert.ok(!title.includes("hidden"));
        assert.equal(options.initialIndex, 1);
        assert.equal(choices[0], "拒绝执行");
        assert.equal(choices[1], "仅批准本次调用（模型建议）");
        return choice === "仅批准本次调用" ? choices[1] : choice;
      });
      const result = await f.engine.handle(call(), c.ctx);
      assert.equal(result?.block, choice === "仅批准本次调用" ? undefined : true);
      assert.equal(f.records[0].decision, "ask");
      assert.equal(f.records[0].recommendation?.action, "approve");
      assert.ok(!JSON.stringify(f.records).includes("hidden"));
    }
  } finally { await w.cleanup(); }
});

function fixture(overrides: Partial<Dependencies> = {}) {
  const records: AuditRecord[] = [];
  let reviews = 0;
  const engine = new ReviewEngine({
    config: () => ({ ...defaults, model: "test/reviewer", reviewTimeoutMs: 100, confirmationTimeoutMs: 200 }),
    sources: () => [builtin("bash"), builtin("write"), builtin("read")], protectedRoots: [],
    review: async () => { reviews++; return allow; },
    audit: async r => { records.push(r); }, ...overrides,
  }, new ConfirmationQueue());
  return { engine, records, reviews: () => reviews };
}
async function execute(engine: ReviewEngine, ctx: ExtensionContext, onExecute: () => void, id?: string) {
  const result = await engine.handle(call("bash", { command: "pwd" }, id), ctx);
  if (!result?.block) onExecute();
  return result;
}

test("allow executes once, read bypasses model, and identical commands are reviewed again", async () => {
  const w = await workspace();
  try {
    const f = fixture(); const { ctx } = context(w.cwd); let executed = 0;
    await execute(f.engine, ctx, () => executed++);
    await execute(f.engine, ctx, () => executed++, "call-2");
    assert.equal(executed, 2); assert.equal(f.reviews(), 2);
    assert.equal(f.records.length, 2);
    assert.notEqual(f.records[0].operationHash, f.records[1].operationHash);
    assert.equal(await f.engine.handle(call("read", { path: "a.ts" }), ctx), undefined);
    assert.equal(f.reviews(), 2);
  } finally { await w.cleanup(); }
});

test("deny, ask, auth/network errors and timeout never execute headlessly", async () => {
  const w = await workspace();
  try {
    for (const review of [
      async () => ({ ...allow, decision: "deny" as const }),
      async () => ({ ...allow, decision: "ask" as const }),
      async () => { throw new Error("Authorization: Bearer sensitive-token"); },
      async () => { throw new Error("network failure"); },
      async () => { throw new Error("invalid JSON"); },
      async () => new Promise<Verdict>(() => {}),
    ]) {
      const f = fixture({ review, config: () => ({ ...defaults, model: "test/reviewer", reviewTimeoutMs: 10, confirmationTimeoutMs: 30 }) });
      let executed = 0;
      assert.equal((await execute(f.engine, context(w.cwd).ctx, () => executed++))?.block, true);
      assert.equal(executed, 0);
      assert.ok(!JSON.stringify(f.records).includes("sensitive-token"));
    }
  } finally { await w.cleanup(); }
});

test("human override is explicit, defaults to reject, and displays the full operation", async () => {
  const w = await workspace();
  try {
    for (const choice of [undefined, "拒绝执行", "仅批准本次调用"]) {
      const f = fixture({ review: async () => ({ ...allow, decision: "deny" }) });
      const { ctx } = context(w.cwd, async (title, choices, options) => {
        assert.ok(title.includes('"command": "pwd"')); assert.ok(title.includes(w.cwd));
        assert.deepEqual(choices, ["拒绝执行", "仅批准本次调用"]); assert.equal(options.initialIndex, 0);
        return choice;
      });
      let executed = 0; await execute(f.engine, ctx, () => executed++);
      assert.equal(executed, choice === "仅批准本次调用" ? 1 : 0);
      assert.equal(f.records[0].humanOverride, choice === "仅批准本次调用");
    }
    const f = fixture({ config: () => ({ ...defaults }) });
    let executed = 0;
    await execute(f.engine, context(w.cwd, async () => "仅批准本次调用").ctx, () => executed++);
    assert.equal(executed, 1); assert.equal(f.reviews(), 0);
  } finally { await w.cleanup(); }
});

test("cancellation, changed parameters and changed session invalidate approvals", async () => {
  const w = await workspace();
  try {
    for (const change of ["cancel", "parameters", "session", "cwd"]) {
      const event = call();
      const f = fixture({ review: async () => ({ ...allow, decision: "ask" }) });
      const c = context(w.cwd, async () => {
        if (change === "cancel") f.engine.cancel();
        if (change === "parameters") event.input.command = "different";
        if (change === "session") c.switchSession();
        if (change === "cwd") c.ctx.cwd = "/other";
        return "仅批准本次调用";
      });
      assert.equal((await f.engine.handle(event, c.ctx))?.block, true, change);
    }
  } finally { await w.cleanup(); }
});

test("late model responses and late confirmations cannot approve expired calls", async () => {
  const w = await workspace();
  try {
    const f = fixture({
      config: () => ({ ...defaults, model: "test/reviewer", reviewTimeoutMs: 10, confirmationTimeoutMs: 15 }),
      review: async () => { await sleep(60); return allow; },
    });
    const c = context(w.cwd, async () => { await sleep(60); return "仅批准本次调用"; });
    assert.equal((await f.engine.handle(call(), c.ctx))?.block, true);
    await sleep(75);
    assert.equal(f.records[0].outcome, "blocked");
  } finally { await w.cleanup(); }
});

test("parallel confirmations serialize and cancelled queued requests never show", async () => {
  const q = new ConfirmationQueue();
  const a = new AbortController(), b = new AbortController(), c = new AbortController();
  const order: string[] = [];
  let release!: () => void;
  const first = q.run(a.signal, async () => { order.push("a"); await new Promise<void>(r => { release = r; }); });
  await sleep(1);
  const second = q.run(b.signal, async () => { order.push("b"); });
  const secondRejected = assert.rejects(second);
  const third = q.run(c.signal, async () => { order.push("c"); });
  b.abort(); await secondRejected;
  assert.deepEqual(order, ["a"]);
  release(); await Promise.all([first, third]);
  assert.deepEqual(order, ["a", "c"]);
});

test("audit failure blocks; cancellation during audit cannot release execution", async () => {
  const w = await workspace();
  try {
    const f = fixture({ audit: async () => { throw new Error("disk full"); } });
    assert.equal((await f.engine.handle(call(), context(w.cwd).ctx))?.block, true);
    const g = fixture({ audit: async () => { g.engine.cancel(); } });
    assert.equal((await g.engine.handle(call(), context(w.cwd).ctx))?.block, true);
  } finally { await w.cleanup(); }
});

test("changed ancestor authorization invalidates a pending child approval", async () => {
  const w = await workspace();
  try {
    const history: unknown[] = [{ type: "auto_review_ancestor_user", sourceSessionId: "parent", message: { role: "user", content: "run tests" } }];
    const f = fixture({ history: () => history, review: async () => {
      history.push({ type: "auto_review_ancestor_user", sourceSessionId: "parent", message: { role: "user", content: "stop" } });
      return allow;
    } });
    assert.equal((await f.engine.handle(call(), context(w.cwd).ctx))?.block, true);
  } finally { await w.cleanup(); }
});

test("status reports final reviewed outcome, skips bypasses, and cannot affect approval", async () => {
  const w = await workspace();
  try {
    const updates: unknown[] = [];
    const f = fixture({ onResult: (operation, result) => { updates.push({ tool: operation.toolName, ...result }); } });
    await f.engine.handle(call(), context(w.cwd).ctx);
    await f.engine.handle(call("read", { path: "a.ts" }), context(w.cwd).ctx);
    assert.deepEqual(updates, [{ tool: "bash", decision: "allow", outcome: "allowed", humanOverride: false }]);
    const g = fixture({ audit: async () => { throw new Error("disk full"); }, onResult: (operation, result) => { updates.push({ tool: operation.toolName, ...result }); } });
    assert.equal((await g.engine.handle(call(), context(w.cwd).ctx))?.block, true);
    assert.deepEqual(updates[1], { tool: "bash", decision: "error", outcome: "blocked", humanOverride: false });
    const h = fixture({ onResult: () => { throw new Error("UI unavailable"); } });
    assert.equal(await h.engine.handle(call(), context(w.cwd).ctx), undefined);
  } finally { await w.cleanup(); }
});
