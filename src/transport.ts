import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewConfig } from "./config.ts";
import { buildReviewData, parseVerdict, REVIEW_PROMPT, type ReviewRequest, type Verdict } from "./reviewer.ts";
import { reviewReasoning } from "./thinking.ts";
import { reviewWithFallback } from "./fallback.ts";
import { ReviewAttemptError, type AttemptObserver } from "./attempt.ts";

export async function reviewWithModel(request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext, signal: AbortSignal, onAttempt?: AttemptObserver): Promise<Verdict> {
  if (!config.model) throw new Error("尚未配置审核模型");
  const content = buildReviewData(request, config);
  // The chain is built once per call: primary first, then the configured backups in order.
  const candidates = [config.model, ...(config.fallbackModels ?? [])];
  return reviewWithFallback(candidates, config.reviewTimeoutMs, signal, async (spec, attemptSignal, index, retryIndex) => {
    const slash = spec.indexOf("/");
    // Every configured candidate is an exact lookup; never fall back to the agent's main model.
    const model = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (!model) throw new ReviewAttemptError("missing_model");
    const reasoning = reviewReasoning(model);
    const response = await completeSimple(model, {
      systemPrompt: [REVIEW_PROMPT],
      messages: [{ role: "user", content, timestamp: Date.now() }],
      tools: [],
    }, {
      apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
      headers: ctx.modelRegistry.getProviderHeaders(model.provider),
      // Distinct provider session per attempt: session routing, prompt-cache keys and the
      // Claude Code attribution metadata are keyed off it, so a retry never inherits the
      // failed attempt's session identity.
      sessionId: `auto-review:${ctx.sessionManager.getSessionId()}:${request.operation.toolCallId}:${index}:${retryIndex}`,
      signal: attemptSignal, maxTokens: 2048,
      ...(reasoning === undefined ? {} : { reasoning }),
    });
    if (attemptSignal.aborted) throw new Error("审核已取消");
    if (response.stopReason === "length") throw new ReviewAttemptError("output_limit");
    if (response.stopReason === "error") throw new ReviewAttemptError("call_error");
    if (response.stopReason !== "stop" || response.content.some(c => c.type === "toolCall")) throw new ReviewAttemptError("incomplete");
    try { return parseVerdict(response.content.filter(c => c.type === "text").map(c => c.text).join("")); }
    catch { throw new ReviewAttemptError("invalid_response"); }
  }, onAttempt, { modelTimeoutMs: config.modelTimeoutMs ?? 10_000, retryCount: config.retryCount ?? 1, retryDelayMs: config.retryDelayMs ?? 500 });
}
