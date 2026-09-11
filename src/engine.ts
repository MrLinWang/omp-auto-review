import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewConfig } from "./config.ts";
import type { AuditRecord } from "./audit.ts";
import { classify, type ToolCall, type ToolSource } from "./policy.ts";
import { canonical, fingerprint, redact, safeText } from "./privacy.ts";
import type { ReviewRequest, Verdict } from "./reviewer.ts";
import { authorityFingerprint } from "./context.ts";

export interface Dependencies {
  config(): ReviewConfig;
  sources(): ToolSource[];
  history?(ctx: ExtensionContext): unknown[];
  protectedRoots: string[];
  review(request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext, signal: AbortSignal): Promise<Verdict>;
  audit(record: AuditRecord): Promise<void>;
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
    let hash = "", snapshot: ToolCall;
    let outcome: "allowed" | "blocked" = "blocked";
    let humanOverride = false;
    let decision: AuditRecord["decision"] = "error";
    let reason = "审核未完成";
    let model: string | null = null;
    try {
      snapshot = JSON.parse(canonical(event)) as ToolCall;
      hash = fingerprint({ sessionId, cwd, operation: snapshot });
      const policy = await classify(snapshot, cwd, this.deps.sources().find(t => t.name === event.toolName), this.deps.protectedRoots);
      if (controller.signal.aborted) return { block: true, reason: "审核会话已取消" };
      if (!policy.review) return undefined;

      let config: ReviewConfig;
      try { config = this.deps.config(); }
      catch { config = { reviewTimeoutMs: 20_000, confirmationTimeoutMs: 90_000, maxOperationBytes: 32_768, maxContextBytes: 24_576 }; }
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
      try {
        if (!config.model) throw new Error("审核模型未配置或配置无效");
        const verdict = await withSignal(this.deps.review({
          operation: snapshot, cwd, trigger: policy.reason, history,
        }, config, ctx, reviewController.signal), reviewController.signal);
        decision = verdict.decision;
        reason = redact(verdict.reason);
      } catch {
        reason = config.model ? "审核模型调用失败、超时或响应无效，需人工确认" : "审核模型未配置或配置无效，需人工确认";
      } finally {
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
              const result = await ctx.ui.select(safeText(
                `自动审核：${decision}\n原因：${reason}\n工作目录：${cwd}\n工具：${snapshot.toolName}\n调用：${snapshot.toolCallId}\n${operationText}`,
              ), ["拒绝执行", "仅批准本次调用"], { initialIndex: 0, signal: controller.signal, timeout });
              return result === "仅批准本次调用" && !controller.signal.aborted && Date.now() < deadline;
            });
            if (accepted) { humanOverride = true; outcome = "allowed"; }
          } catch { /* Cancel, expiry and unavailable UI all block. */ }
        } else reason = "完整操作过大，无法安全展示；请拆分操作后重试";
      }

      if (controller.signal.aborted || authorizationChanged() || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd ||
          fingerprint({ sessionId, cwd, operation: event }) !== hash) {
        outcome = "blocked"; humanOverride = false; reason = "调用已取消、过期或参数/会话已变化，请重新审核";
      }
      await withSignal(this.deps.audit({
        timestamp: new Date().toISOString(), sessionId, toolCallId: snapshot.toolCallId, toolName: snapshot.toolName,
        operationHash: hash, parameterSummary: { keys: Object.keys(snapshot.input), bytes: Buffer.byteLength(canonical(snapshot.input)) },
        model, decision, reason, outcome, humanOverride, elapsedMs: Date.now() - started,
      }), controller.signal);
      // Audit I/O can yield; re-check cancellation and mutation after it too.
      if (controller.signal.aborted || authorizationChanged() || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd ||
          fingerprint({ sessionId, cwd, operation: event }) !== hash) return { block: true, reason: "调用已失效，请重新审核" };
      return outcome === "allowed" ? undefined : { block: true, reason: `自动审核已阻止调用：${safeText(reason)}。请调整方案或向用户说明。` };
    } catch {
      return { block: true, reason: "自动审核内部错误或审计记录写入失败，已阻止执行" };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      controller.abort();
      this.pending.delete(controller);
    }
  }
}
