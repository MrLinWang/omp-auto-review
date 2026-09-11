import { completeSimple, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewConfig } from "./config.ts";
import { buildReviewData, parseVerdict, REVIEW_PROMPT, type ReviewRequest, type Verdict } from "./reviewer.ts";

export async function reviewWithModel(request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext, signal: AbortSignal): Promise<Verdict> {
  if (!config.model) throw new Error("尚未配置审核模型");
  const slash = config.model.indexOf("/");
  // Exact lookup: never silently select a fuzzy match or fall back to the main model.
  const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
  if (!model) throw new Error("配置的审核模型不存在");
  const content = buildReviewData(request, config);
  const response = await completeSimple(model, {
    systemPrompt: [REVIEW_PROMPT],
    messages: [{ role: "user", content, timestamp: Date.now() }],
    tools: [],
  }, {
    apiKey: ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
    headers: ctx.modelRegistry.getProviderHeaders(model.provider),
    sessionId: `auto-review:${ctx.sessionManager.getSessionId()}:${request.operation.toolCallId}`,
    signal, maxTokens: 2048, reasoning: "low" as SimpleStreamOptions["reasoning"],
  });
  if (signal.aborted) throw new Error("审核已取消");
  if (response.stopReason !== "stop" || response.content.some(c => c.type === "toolCall")) throw new Error("审核未正常完成");
  return parseVerdict(response.content.filter(c => c.type === "text").map(c => c.text).join(""));
}
