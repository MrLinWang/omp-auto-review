import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewConfig } from "./config.ts";
import type { AuditRecord } from "./audit.ts";
import { classify, type ToolCall, type ToolSource } from "./policy.ts";
import { canonical, fingerprint, redact, safeText } from "./privacy.ts";
import type { ReviewRequest, Verdict } from "./reviewer.ts";
import { authorityFingerprint } from "./context.ts";
import type { ReviewResult } from "./status.ts";
import { selectConfirmation } from "./confirmation.ts";
import { formatAttempts, type AttemptObserver, type ReviewAttempt } from "./attempt.ts";

export interface Dependencies {
  config(): ReviewConfig;
  sources(): ToolSource[];
  history?(ctx: ExtensionContext): unknown[];
  protectedRoots: string[];
  review(request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext, signal: AbortSignal, onAttempt?: AttemptObserver): Promise<Verdict>;
  audit(record: AuditRecord): Promise<void>;
  onResult?(operation: ToolCall, result: ReviewResult, ctx: ExtensionContext): void;
}

export async function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("已取消或超时");
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("已取消或超时"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

// Shared across rebound extension factories, so parent/child dialogs never overlap.
export class ConfirmationQueue {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => gate);
    try {
      await withSignal(previous, signal);
      if (signal.aborted) throw new Error("确认已过期");
      return await withSignal(fn(), signal);
    } finally { release(); }
  }
}
const confirmations = new ConfirmationQueue();

export class ReviewEngine {
  private pending = new Set<AbortController>();
  constructor(private readonly deps: Dependencies, private readonly queue = confirmations) {}
  cancel(): void {
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
  async handle(event: ToolCall, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    const started = Date.now();
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const controller = new AbortController();
    this.pending.add(controller);
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    let hash = "";
    let snapshot!: ToolCall;
    let reviewed = false;
    let outcome: "allowed" | "blocked" = "blocked";
    let humanOverride = false;
    let automaticRecommendation = false;
    let decision: AuditRecord["decision"] = "error";
    let reason = "审核未完成";
    let recommendation: Verdict["recommendation"];
    let model: string | null = null;
    let fallbackUsed = false;
    const attempts: ReviewAttempt[] = [];
    try {
      snapshot = JSON.parse(canonical(event)) as ToolCall;
      hash = fingerprint({ sessionId, cwd, operation: snapshot });
      const policy = await classify(snapshot, cwd, this.deps.sources().find(t => t.name === event.toolName), this.deps.protectedRoots);
      if (controller.signal.aborted) return { block: true, reason: "审核会话已取消" };
      if (!policy.review) return undefined;
      reviewed = true;

      let config: ReviewConfig;
      try { config = this.deps.config(); }
      catch { config = { fallbackModels: [], reviewTimeoutMs: 20_000, confirmationTimeoutMs: 90_000, maxOperationBytes: 32_768, maxContextBytes: 24_576 }; }
      model = config.model ?? null;
      const history = this.deps.history?.(ctx) ?? ctx.sessionManager.getBranch();
      const authority = authorityFingerprint(history);
      const authorizationChanged = () => authorityFingerprint(this.deps.history?.(ctx) ?? ctx.sessionManager.getBranch()) !== authority;
      const deadline = started + config.reviewTimeoutMs + config.confirmationTimeoutMs;
      overallTimer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      const reviewController = new AbortController();
      const abortReview = () => reviewController.abort();
      controller.signal.addEventListener("abort", abortReview, { once: true });
      const timer = setTimeout(abortReview, config.reviewTimeoutMs);
      let acceptingAttempts = true;
      let attemptStarted = Date.now();
      try {
        if (!config.model) throw new Error("审核模型未配置或配置无效");
        const verdict = await withSignal(this.deps.review({
          operation: snapshot, cwd, trigger: policy.reason, history,
        }, config, ctx, reviewController.signal, attempt => {
          if (!acceptingAttempts) return;
          if (attempt.status === "running") attemptStarted = Date.now();
          const index = attempts.findIndex(previous => previous.model === attempt.model);
          if (index === -1) attempts.push({ ...attempt });
          else attempts[index] = { ...attempt };
          model = attempt.model;
        }), reviewController.signal);
        decision = verdict.decision;
        // The chain reports which candidate decided; `model` falls back to the configured primary.
        model = verdict.reviewerModel ?? model;
        fallbackUsed = verdict.fallbackUsed === true;
        reason = redact(verdict.reason);
        if (verdict.decision === "ask" && verdict.recommendation) {
          recommendation = { action: verdict.recommendation.action, reason: redact(verdict.recommendation.reason) };
        }
      } catch {
        const pending = attempts.at(-1);
        if (pending && (pending.status === "running" || pending.status === "cancelled")) {
          pending.status = controller.signal.aborted ? "cancelled" : reviewController.signal.aborted ? "timeout" : "call_error";
          pending.elapsedMs = Date.now() - attemptStarted;
        }
        reason = config.model ? "审核模型调用失败、超时或响应无效，需人工确认" : "审核模型未配置或配置无效，需人工确认";
        if (attempts.length) reason = `未获得有效审核结论，需人工确认。尝试结果：${formatAttempts(attempts)}`;
      } finally {
        acceptingAttempts = false;
        clearTimeout(timer);
        reviewController.abort();
        controller.signal.removeEventListener("abort", abortReview);
      }

      if (!controller.signal.aborted && decision === "allow") outcome = "allowed";
      else if (!controller.signal.aborted && ctx.hasUI && ctx.mode === "tui") {
        // Never offer approval of an abbreviated operation. Bound display size instead.
        const operationText = JSON.stringify(snapshot.input, null, 2);
        if (Buffer.byteLength(operationText) <= 131_072) {
          try {
            const accepted = await this.queue.run(controller.signal, async () => {
              const timeout = Math.min(config.confirmationTimeoutMs, deadline - Date.now());
              if (timeout <= 0) return false;
              const configuredDelay = config.recommendationTimeoutMs ?? 15_000;
              // Auto-decide only for ask with a recommendation, and only when the remaining
              // window fits the full delay plus a margin for the final validation and audit;
              // never advertise a wait the dialog would have to shorten.
              const delay = decision === "ask" && recommendation && configuredDelay > 0 && configuredDelay + 1000 < timeout
                ? configuredDelay : 0;
              const advice = decision === "ask" ? recommendation
                ? `\n模型推荐：${recommendation.action === "approve" ? "建议批准本次调用" : "建议拒绝本次调用"}\n推荐理由：${recommendation.reason}`
                : "\n模型推荐：未提供" : "";
              const countdown = delay ? `\n${delay / 1000} 秒内未选择，将自动${recommendation!.action === "approve" ? "批准" : "拒绝"}本次调用；取消可阻止自动决策。` : "";
              const result = await selectConfirmation(ctx, safeText(
                `自动审核：${decision}\n${decision === "error" ? "最后尝试模型" : "审核模型"}：${model}${fallbackUsed || attempts.length > 1 ? "（备用）" : ""}\n原因：${reason}${advice}${countdown}\n工作目录：${cwd}\n工具：${snapshot.toolName}\n调用：${snapshot.toolCallId}\n${operationText}`,
              ), controller.signal, timeout, delay, recommendation?.action);
              if (controller.signal.aborted || Date.now() >= deadline) return false;
              automaticRecommendation = result === "recommendation";
              return result === "approve" || (automaticRecommendation && recommendation?.action === "approve");
            });
            if (accepted) { humanOverride = !automaticRecommendation; outcome = "allowed"; }
          } catch { /* Cancel, expiry and unavailable UI all block. */ }
        } else reason = "完整操作过大，无法安全展示；请拆分操作后重试";
      }

      if (controller.signal.aborted || authorizationChanged() || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd ||
          fingerprint({ sessionId, cwd, operation: event }) !== hash) {
        outcome = "blocked"; humanOverride = false; automaticRecommendation = false; reason = "调用已取消、过期或参数/会话已变化，请重新审核";
      }
      await withSignal(this.deps.audit({
        timestamp: new Date().toISOString(), sessionId, toolCallId: snapshot.toolCallId, toolName: snapshot.toolName,
        operationHash: hash, parameterSummary: { keys: Object.keys(snapshot.input), bytes: Buffer.byteLength(canonical(snapshot.input)) },
        model, ...(attempts.length ? { attempts } : {}), ...(fallbackUsed ? { fallbackUsed: true } : {}), decision, reason, ...(recommendation ? { recommendation } : {}), outcome, humanOverride, ...(automaticRecommendation ? { automaticRecommendation: true } : {}), elapsedMs: Date.now() - started,
      }), controller.signal);
      // Audit I/O can yield; re-check cancellation and mutation after it too.
      if (controller.signal.aborted || authorizationChanged() || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd ||
          fingerprint({ sessionId, cwd, operation: event }) !== hash) {
        outcome = "blocked";
        humanOverride = false;
        automaticRecommendation = false;
        return { block: true, reason: "调用已失效，请重新审核" };
      }
      return outcome === "allowed" ? undefined : { block: true, reason: `自动审核已阻止调用：${safeText(reason)}。请调整方案或向用户说明。` };
    } catch {
      outcome = "blocked";
      decision = "error";
      humanOverride = false;
      automaticRecommendation = false;
      return { block: true, reason: "自动审核内部错误或审计记录写入失败，已阻止执行" };
    } finally {
      // Only reviews that ran on a still-current call are reported.
      if (reviewed && snapshot && !controller.signal.aborted && ctx.sessionManager.getSessionId() === sessionId && ctx.cwd === cwd) {
        try { this.deps.onResult?.(snapshot, { decision, outcome, humanOverride, ...(fallbackUsed ? { fallbackUsed: true, model } : {}), ...(automaticRecommendation ? { automaticRecommendation: true } : {}) }, ctx); }
        catch { /* Status rendering must not change an approval decision. */ }
      }
      if (overallTimer) clearTimeout(overallTimer);
      controller.abort();
      this.pending.delete(controller);
    }
  }
}
