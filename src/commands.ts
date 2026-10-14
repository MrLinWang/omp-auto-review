import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ConfigStore, jevBudgetMs, jevDefaults, type ReviewConfig } from "./config.ts";
import { safeText } from "./privacy.ts";

interface CommandState {
  config(): ReviewConfig;
  configError(): boolean;
  status(ctx: ExtensionContext): string;
  load(ctx: ExtensionContext): Promise<void>;
  cancel(): void;
  store: ConfigStore;
  /** Full provider/model ids for display; listing does not resolve keys or command-backed headers. */
  jevModels(ctx: ExtensionContext): readonly string[];
}

/** Hint shown when the prefilter is enabled but the host has no usable native judge candidate. */
const JEV_NO_CANDIDATE_HINT = "未找到可用的 OMP judge 决策模型，前置审查会被跳过；请在 OMP 中配置 modelRoles.judge 及对应模型的鉴权";

function jevLines(config: ReviewConfig, configError: boolean, models: readonly string[]): string {
  const jev = config.jev;
  if (!jev) return "前置审查（jev）：未配置";
  const enabled = !configError && jev.enabled !== false;
  const lines = [
    `前置审查（jev）：${enabled ? "开启" : "关闭"}；可信阈值：${jev.confidenceThreshold}`,
    `前置审查模型（OMP judge 原生候选）：${models.length ? models.join("；") : "无"}`,
    `前置审查超时：${jev.timeoutMs}ms；额外重试：${jev.retryCount}次；重试间隔：${jev.retryDelayMs}ms（最坏占用审核总超时 ${jevBudgetMs(jev)}ms）`,
  ];
  if (enabled && models.length === 0) lines.push(JEV_NO_CANDIDATE_HINT);
  return lines.join("\n");
}

/** Register user commands independently of the model transport. */
export function registerReviewCommand(pi: Pick<ExtensionAPI, "registerCommand">, state: CommandState): void {
  pi.registerCommand("auto-review", {
    description: "独立模型审核：on | off | status | bash on|off | jev on|off | model <provider/model> | reload",
    handler: async (args, ctx) => {
      const config = state.config();
      const configError = state.configError();
      const parts = args.trim().split(/\s+/);
      if (!args.trim() || (parts[0] === "status" && parts.length === 1)) {
        const models = state.jevModels(ctx);
        const jev = config.jev;
        // An enabled prefilter without a usable host candidate silently does nothing; warn instead.
        const jevIdle = !configError && jev !== undefined && jev.enabled !== false && models.length === 0;
        ctx.ui.notify(safeText(`${state.status(ctx)}\n备用模型：${config.fallbackModels.join(" → ") || "未配置"}\n${jevLines(config, configError, models)}\nBash 免审总开关：${!configError && config.bashBypassEnabled !== false ? "开启" : "关闭"}\n只读预设：${config.bashReadonlyPreset ?? "common"}\n附加免审规则：${config.bashAllowCommands?.join("；") || "无附加规则"}\n审查日志：${config.reviewLogPath ? resolve(state.store.agentDir, config.reviewLogPath) : "已关闭"}\n配置：${state.store.path}\n审核总超时：${config.reviewTimeoutMs}ms；单次调用上限：${config.modelTimeoutMs ?? 10_000}ms\n每个模型额外重试：${config.retryCount ?? 1}次；重试间隔：${config.retryDelayMs ?? 500}ms\n确认超时：${config.confirmationTimeoutMs}ms；自动决策等待：${config.recommendationTimeoutMs ?? 15_000}ms（0 为关闭）\n子 agent 覆盖取决于扩展继承；原生审批仍生效。`), jevIdle ? "warning" : "info");
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
      else if (parts[0] === "jev" && parts.length === 2 && ["on", "off"].includes(parts[1])) {
        // Same rule as the Bash switch: a malformed file is never overwritten with defaults.
        if (configError) { ctx.ui.notify("配置无效，请修复后 reload 再切换前置审查开关", "error"); return; }
        try {
          // Turning it on without a block writes the documented defaults, ready for the host's judge role.
          await state.store.save({ ...config, jev: { ...(config.jev ?? jevDefaults), enabled: parts[1] === "on" } });
          await state.load(ctx);
          if (state.configError()) { ctx.ui.notify("开关已保存，但配置重载失败；前置审查已禁用", "error"); return; }
          const jev = state.config().jev;
          if (!jev || jev.enabled === false) { ctx.ui.notify("前置审查（jev）：关闭；受审调用直接交给 LLM 审核链", "info"); return; }
          const models = state.jevModels(ctx);
          const missing = models.length === 0;
          ctx.ui.notify(`前置审查（jev）：开启；可信阈值：${jev.confidenceThreshold}；OMP judge 候选：${models.join("；") || "无"}${missing ? `\n${JEV_NO_CANDIDATE_HINT}` : ""}`, missing ? "warning" : "info");
        } catch { ctx.ui.notify("无法保存用户级审核配置，前置审查开关未切换", "error"); }
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
      } else ctx.ui.notify("用法：/auto-review on | off | status | bash on|off | jev on|off | model <provider/model> | reload", "info");
    },
  });
}
