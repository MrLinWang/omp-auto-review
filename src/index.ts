import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendAudit } from "./audit.ts";
import { appendReviewLog } from "./review-log.ts";
import { ConfigStore, defaults, jevApiKey, type ReviewConfig } from "./config.ts";
import { ReviewEngine } from "./engine.ts";
import type { ToolCall } from "./policy.ts";
import { collectHistory } from "./context.ts";
import { safeText } from "./privacy.ts";
import { reviewWithLlm } from "./transport.ts";
import { prefilterChain } from "./chain.ts";
import { reviewStatus } from "./status.ts";
import { registerReviewCommand } from "./commands.ts";

export default function autoReview(pi: ExtensionAPI): void {
  const agentDir = pi.pi.getAgentDir();
  const store = new ConfigStore(agentDir);
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let config: ReviewConfig = { ...defaults };
  let configError: string | undefined;
  let latestReview: string | undefined;
  const engine = new ReviewEngine({
    config: () => { if (configError) throw new Error(configError); return config; },
    sources: () => pi.getAllTools(),
    history: ctx => collectHistory(ctx, pi.pi.AgentRegistry.global()),
    protectedRoots: [agentDir, pluginRoot],
    review: prefilterChain(reviewWithLlm),
    audit: record => appendAudit(agentDir, record),
    reviewLog: (path, record) => appendReviewLog(agentDir, path, record),
    onResult: (operation, result, ctx) => {
      latestReview = reviewStatus(operation, result);
      ctx.ui.setStatus("auto-review", statusLine(ctx));
    },
  });

  const status = (ctx: ExtensionContext): string => {
    if (configError) return "未就绪：配置无效";
    if (config.enabled === false) return "已关闭";
    let ready = false;
    if (config.model) {
      // Any resolvable candidate counts: the primary may be missing while a backup still runs.
      ready = [config.model, ...config.fallbackModels].some(spec => {
        const slash = spec.indexOf("/");
        return Boolean(ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)));
      });
    }
    // The prefilter is a reviewer in its own right: with a key it can decide inside the threshold.
    const prefilter = config.jev && config.jev.enabled !== false && jevApiKey(config.jev).key ? config.jev : undefined;
    if (ready) return `已启用：${config.model}${prefilter ? ` · 前置：${prefilter.model}` : ""}`;
    if (prefilter) return `已启用：前置审查 ${prefilter.model}${config.model ? "；LLM 审核模型不可用，阈值外需人工确认" : "；未配置 LLM 审核模型，阈值外需人工确认"}`;
    return "未就绪：请配置可用的审核模型；受审操作需人工确认";
  };
  const statusLine = (ctx: ExtensionContext): string => safeText(
    `Auto review · ${status(ctx)}${latestReview ? ` · 最近：${latestReview}` : ""}`,
  );
  const showStatus = (ctx: ExtensionContext): void => {
    const message = statusLine(ctx);
    ctx.ui.setStatus("auto-review", message);
    if (ctx.hasUI) ctx.ui.notify(message, configError || (config.enabled !== false && !config.model) ? "warning" : "info");
    else pi.logger.info(message);
  };
  const load = async (ctx: ExtensionContext): Promise<void> => {
    engine.cancel();
    // Never keep showing another session's or a stale config's result.
    latestReview = undefined;
    try { config = await store.load(); configError = undefined; }
    catch { config = { ...defaults }; configError = "用户级 auto-review.json 无效"; }
    showStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => { await load(ctx); });
  pi.on("session_switch", async (_event, ctx) => { await load(ctx); });
  pi.on("session_before_switch", () => { engine.cancel(); });
  pi.on("session_before_branch", () => { engine.cancel(); });
  pi.on("session_before_tree", () => { engine.cancel(); });
  pi.on("session_shutdown", () => { engine.cancel(); });
  pi.on("agent_end", () => { engine.cancel(); });
  pi.on("input", () => { engine.cancel(); });
  pi.on("tool_call", (event, ctx) => engine.handle(event as ToolCall, ctx));
  registerReviewCommand(pi, {
    config: () => config, configError: () => Boolean(configError), status, load,
    cancel: () => engine.cancel(), store,
  });
}
