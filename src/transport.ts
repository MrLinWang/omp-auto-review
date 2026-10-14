import { completeSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import { createNativeJudge, isJudgmentApi, JudgmentApiError } from "@oh-my-pi/pi-ai/judgment";
import { settings, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { LlmReviewer } from "./chain.ts";
import { parseVerdict, REVIEW_PROMPT } from "./reviewer.ts";
import { reviewReasoning } from "./thinking.ts";
import { reviewWithFallback } from "./fallback.ts";
import { httpAttemptCode, ReviewAttemptError } from "./attempt.ts";
import type { JevCandidate } from "./jev.ts";

/** The LLM chain: primary first, then the configured backups in order, inside `budgetMs`. */
export const reviewWithLlm: LlmReviewer = (content, request, config, ctx, signal, onAttempt, budgetMs) => {
  // The chain is built once per call: primary first, then the configured backups in order.
  const candidates = [config.model!, ...(config.fallbackModels ?? [])];
  return reviewWithFallback(candidates, budgetMs, signal, async (spec, attemptSignal, index, retryIndex) => {
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
      headers: await ctx.modelRegistry.resolveModelHeaders(model, attemptSignal),
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
    try { return { ...parseVerdict(response.content.filter(c => c.type === "text").map(c => c.text).join("")), source: "llm" as const }; }
    catch { throw new ReviewAttemptError("invalid_response"); }
  }, onAttempt, { modelTimeoutMs: config.modelTimeoutMs ?? 10_000, retryCount: config.retryCount ?? 1, retryDelayMs: config.retryDelayMs ?? 500 });
};

/** Caps successful native response bodies at 64 KiB before the SDK decodes them. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReviewAttemptError("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new ReviewAttemptError("output_limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Rejects redirects and discards HTTP error bodies before they can enter SDK diagnostics. */
const safeFetch: FetchImpl = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return new Response(await readCapped(response), { status: response.status, headers: response.headers });
};

/** Selects native APIs from the host's available judge chain; keys and headers resolve on attempt. */
export function selectJevCandidates(ctx: ExtensionContext): JevCandidate[] {
  const registry = ctx.modelRegistry;
  const pool = roleCandidatePool("judge", settings, registry);
  return resolveRoleChain("judge", settings, pool)
    .filter(({ model }) => isJudgmentApi(model.api))
    .map<JevCandidate>(({ model }) => ({
      model: `${model.provider}/${model.id}`,
      judge: async (request, options) => {
        const signal = options?.signal;
        const sessionId = ctx.sessionManager.getSessionId();
        try {
          signal?.throwIfAborted();
          if (!(await registry.getApiKey(model, sessionId, { signal }))) throw new ReviewAttemptError("auth_error");
          const headers = await registry.resolveModelHeaders(model, signal);
          return await createNativeJudge(model, { apiKey: registry.resolver(model, sessionId), headers, fetch: safeFetch }).judge(request, options);
        } catch (error) {
          if (signal?.aborted || error instanceof ReviewAttemptError) throw error;
          if (error instanceof JudgmentApiError) {
            throw new ReviewAttemptError(error.status === 402 ? "auth_error" : httpAttemptCode(error.status));
          }
          if (error instanceof ProviderResponseError || error instanceof SyntaxError) throw new ReviewAttemptError("invalid_response");
          throw new ReviewAttemptError("call_error");
        }
      },
    }));
}
