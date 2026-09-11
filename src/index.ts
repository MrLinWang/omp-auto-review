import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendAudit } from "./audit.ts";
import { ConfigStore, defaults, type ReviewConfig } from "./config.ts";
import { ReviewEngine } from "./engine.ts";
import type { ToolCall } from "./policy.ts";
import { collectHistory } from "./context.ts";
import { safeText } from "./privacy.ts";
import { reviewWithModel } from "./transport.ts";

export default function autoReview(pi: ExtensionAPI): void {
  const agentDir = pi.pi.getAgentDir();
  const store = new ConfigStore(agentDir);
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let config: ReviewConfig = { ...defaults };
  let configError: string | undefined;
  const engine = new ReviewEngine({
    config: () => { if (configError) throw new Error(configError); return config; },
    sources: () => pi.getAllTools(),
    history: ctx => collectHistory(ctx, pi.pi.AgentRegistry.global()),
    protectedRoots: [agentDir, pluginRoot],
    review: reviewWithModel,
    audit: record => appendAudit(agentDir, record),
  });

  const status = (ctx: ExtensionContext): string => {
    let ready = false;
    if (config.model) {
      const slash = config.model.indexOf("/");
      ready = Boolean(ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1)));
    }
    return configError ? "未就绪：配置无效" : ready ? `已启用：${config.model}` : "未就绪：请配置可用的审核模型；受审操作需人工确认";
  };
  const showStatus = (ctx: ExtensionContext): void => {
    const message = safeText(`Auto review · ${status(ctx)}`);
    ctx.ui.setStatus("auto-review", message);
    if (ctx.hasUI) ctx.ui.notify(message, configError || !config.model ? "warning" : "info");
    else pi.logger.info(message);
  };
  const load = async (ctx: ExtensionContext): Promise<void> => {
    engine.cancel();
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
  pi.registerCommand("auto-review", {
    description: "独立模型审核：status | model <provider/model> | reload",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || (parts[0] === "status" && parts.length === 1)) {
        ctx.ui.notify(safeText(`${status(ctx)}\n配置：${store.path}\n审核超时：${config.reviewTimeoutMs}ms；确认超时：${config.confirmationTimeoutMs}ms\n受限子 agent 不继承插件；原生审批仍生效。`), "info");
      } else if (parts[0] === "reload" && parts.length === 1) await load(ctx);
      else if (parts[0] === "model" && parts.length === 2) {
        const spec = parts[1];
        const slash = spec.indexOf("/");
        if (slash < 1 || !ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))) {
          ctx.ui.notify("模型不存在；请使用 omp models 中的完整 provider/model", "error");
          return;
        }
        engine.cancel();
        try {
          await store.save({ ...config, model: spec });
          await load(ctx);
        } catch { ctx.ui.notify("无法保存用户级审核配置", "error"); }
      } else ctx.ui.notify("用法：/auto-review status | model <provider/model> | reload", "info");
    },
  });
}
