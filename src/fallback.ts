import type { Verdict } from "./reviewer.ts";
import { attemptErrorCode, type AttemptObserver, type ReviewAttempt } from "./attempt.ts";

/** Per-attempt limits; without them each model gets a single attempt on its remaining time share. */
export interface RetryOptions {
  modelTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  /** Failure categories a retry cannot fix; defaults to the LLM chain's set. */
  permanent?: readonly ReviewAttempt["status"][];
}

const permanentFailures: readonly ReviewAttempt["status"][] = ["missing_model", "auth_error", "output_limit"];

/** Backoff that rejects with the cancellation error as soon as the signal aborts. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => reject(new Error("审核已取消"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else timer = setTimeout(resolve, ms);
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/**
 * Retry transient failures inside each model's time share; permanent errors skip retries and valid results end the chain.
 *
 * Generic over the result so the jev prefilter can reuse the same budget, retry, cancellation
 * and attempt-reporting behaviour for its own outcome type.
 */
export async function reviewWithFallback<T extends object = Verdict>(
  models: readonly string[], timeoutMs: number, signal: AbortSignal,
  review: (model: string, signal: AbortSignal, index: number, retryIndex: number) => Promise<T>,
  onAttempt?: AttemptObserver, options: RetryOptions = {},
): Promise<T & { reviewerModel: string; fallbackUsed?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  const retries = options.retryCount ?? 0;
  const retryDelay = options.retryDelayMs ?? 0;
  for (const [index, model] of models.entries()) {
    if (signal.aborted) throw new Error("审核已取消");
    // Preserve time for later models; retries share this model's remaining budget.
    const modelDeadline = Date.now() + Math.floor((deadline - Date.now()) / (models.length - index));
    for (let retry = 0; retry <= retries; retry++) {
      if (signal.aborted) throw new Error("审核已取消");
      if (retry > 0) {
        // Never start a wait the model's remaining share cannot cover.
        if (modelDeadline - Date.now() <= retryDelay) break;
        if (retryDelay) await delay(retryDelay, signal);
      }
      const timeout = Math.min(options.modelTimeoutMs ?? timeoutMs, modelDeadline - Date.now());
      if (timeout < 1) break;
      const attempt = new AbortController();
      const started = Date.now();
      // Attempt numbers are recorded only when retries are enabled, so single-shot audits keep their shape.
      const report = (status: ReviewAttempt["status"]) => {
        try { onAttempt?.({ model, status, elapsedMs: Date.now() - started, ...(retries ? { attempt: retry + 1 } : {}) }); }
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
      let failure: ReviewAttempt["status"] = "call_error";
      try {
        const result = await Promise.race([aborted, Promise.resolve().then(() => {
          if (attempt.signal.aborted) throw new Error("审核已取消");
          return review(model, attempt.signal, index, retry);
        })]);
        // A verdict that lands after its attempt was aborted or after the budget expired is stale.
        if (signal.aborted || attempt.signal.aborted || Date.now() >= started + timeout) throw new Error("审核已取消或超时");
        report("success");
        return { ...result, reviewerModel: model, ...(index > 0 ? { fallbackUsed: true } : {}) };
      } catch (error) {
        failure = signal.aborted ? "cancelled" : attempt.signal.aborted || Date.now() >= started + timeout ? "timeout" : attemptErrorCode(error);
        report(failure);
        if (signal.aborted) throw new Error("审核已取消");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        attempt.signal.removeEventListener("abort", rejectAbort);
        attempt.abort();
      }
      // A retry cannot fix these; move straight to the next candidate.
      if ((options.permanent ?? permanentFailures).includes(failure)) break;
    }
  }
  throw new Error("所有审核模型均不可用、超时或响应无效");
}
