import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ConfigStore, type ReviewConfig } from "./config.ts";
import { safeText } from "./privacy.ts";

interface CommandState {
  config(): ReviewConfig;
  configError(): boolean;
  status(ctx: ExtensionContext): string;
  load(ctx: ExtensionContext): Promise<void>;
  cancel(): void;
  store: ConfigStore;
}

/** Register user commands independently of the model transport. */
export function registerReviewCommand(pi: Pick<ExtensionAPI, "registerCommand">, state: CommandState): void {
  pi.registerCommand("auto-review", {
    description: "独立模型审核：on | off | status | bash on|off | model <provider/model> | reload",
    handler: async (args, ctx) => {
      const config = state.config();
      const configError = state.configError();
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || (parts[0] === "status" && parts.length === 1)) {
        ctx.ui.notify(safeText(`${state.status(ctx)}\n备用模型：${config.fallbackModels.join(" → ") || "未配置"}\nBash 免审总开关：${!configError && config.bashBypassEnabled !== false ? "开启" : "关闭"}\n只读预设：${config.bashReadonlyPreset ?? "common"}\n附加免审规则：${config.bashAllowCommands?.join("；") || "无附加规则"}\n审查日志：${config.reviewLogPath ? resolve(state.store.agentDir, config.reviewLogPath) : "已关闭"}\n配置：${state.store.path}\n审核总超时：${config.reviewTimeoutMs}ms；单次调用上限：${config.modelTimeoutMs ?? 10_000}ms\n每个模型额外重试：${config.retryCount ?? 1}次；重试间隔：${config.retryDelayMs ?? 500}ms\n确认超时：${config.confirmationTimeoutMs}ms；自动决策等待：${config.recommendationTimeoutMs ?? 15_000}ms（0 为关闭）\n受限子 agent 不继承插件；原生审批仍生效。`), "info");
      } else if (parts[0] === "reload" && parts.length === 1) await state.load(ctx);
      else if (["on", "off"].includes(parts[0]) && parts.length === 1) {
        // Like the Bash switch: never overwrite a malformed configuration with fallback defaults.
        if (configError) { ctx.ui.notify("配置无效，请修复后 reload 再切换自动审核开关", "error"); return; }
        try {
          await state.store.save({ ...config, enabled: parts[0] === "on" });
          await state.load(ctx);
          if (state.configError()) { ctx.ui.notify("开关已保存，但配置重载失败；受审操作仍需人工确认", "error"); return; }
          ctx.ui.notify(`自动审核：${state.config().enabled !== false ? "已开启" : "已关闭"}；原生审批仍生效`, "info");
        } catch { ctx.ui.notify("无法保存用户级审核配置，自动审核开关未切换", "error"); }
      }
      else if (parts[0] === "bash" && parts.length === 2 && ["on", "off"].includes(parts[1])) {
        // Do not overwrite a malformed configuration with fallback defaults.
        if (configError) { ctx.ui.notify("配置无效，请修复后 reload 再切换免审开关", "error"); return; }
        try {
          await state.store.save({ ...config, bashBypassEnabled: parts[1] === "on" });
          await state.load(ctx);
          if (state.configError()) { ctx.ui.notify("开关已保存，但配置重载失败，Bash 免审已禁用", "error"); return; }
          ctx.ui.notify(`Bash 免审总开关：${state.config().bashBypassEnabled !== false ? "开启" : "关闭"}`, "info");
        } catch { ctx.ui.notify("无法保存用户级审核配置，免审开关未切换", "error"); }
      }
      else if (parts[0] === "model" && parts.length === 2) {
        const spec = parts[1];
        const slash = spec.indexOf("/");
        if (slash < 1 || !ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1))) {
          ctx.ui.notify("模型不存在；请使用 omp models 中的完整 provider/model", "error");
          return;
        }
        state.cancel();
        try {
          await state.store.save({ ...config, model: spec, fallbackModels: config.fallbackModels.filter(model => model !== spec) });
          await state.load(ctx);
        } catch { ctx.ui.notify("无法保存用户级审核配置", "error"); }
      } else ctx.ui.notify("用法：/auto-review on | off | status | bash on|off | model <provider/model> | reload", "info");
    },
  });
}
