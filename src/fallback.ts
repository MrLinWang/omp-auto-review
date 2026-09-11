import type { Verdict } from "./reviewer.ts";
import { attemptErrorCode, type AttemptObserver, type ReviewAttempt } from "./attempt.ts";

/** Only failed attempts advance the chain; every valid verdict ends it. */
export async function reviewWithFallback(
  models: readonly string[], timeoutMs: number, signal: AbortSignal,
  review: (model: string, signal: AbortSignal, index: number) => Promise<Verdict>,
  onAttempt?: AttemptObserver,
): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  for (const [index, model] of models.entries()) {
    if (signal.aborted) throw new Error("审核已取消");
    // Split the remaining budget evenly so one hung attempt cannot starve the rest.
    const timeout = Math.floor((deadline - Date.now()) / (models.length - index));
    if (timeout < 1) break;
    const attempt = new AbortController();
    const started = Date.now();
    const report = (status: ReviewAttempt["status"]) => {
      try { onAttempt?.({ model, status, elapsedMs: Date.now() - started }); }
      catch { /* Diagnostics cannot change the verdict or retry policy. */ }
    };
    report("running");
    const cancel = () => attempt.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("审核尝试已取消或超时"));
      attempt.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(cancel, timeout);
    try {
      const result = await Promise.race([aborted, Promise.resolve().then(() => {
        if (attempt.signal.aborted) throw new Error("审核已取消");
        return review(model, attempt.signal, index);
      })]);
      // A verdict that lands after its attempt was aborted or after the budget expired is stale.
      if (signal.aborted || attempt.signal.aborted || Date.now() >= deadline) throw new Error("审核已取消或超时");
      report("success");
      return { ...result, reviewerModel: model, ...(index > 0 ? { fallbackUsed: true } : {}) };
    } catch (error) {
      report(signal.aborted ? "cancelled" : attempt.signal.aborted || Date.now() >= deadline ? "timeout" : attemptErrorCode(error));
      if (signal.aborted) throw new Error("审核已取消");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      attempt.signal.removeEventListener("abort", rejectAbort);
      attempt.abort();
    }
  }
  throw new Error("所有审核模型均不可用、超时或响应无效");
}
