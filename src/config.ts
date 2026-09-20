import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeBashCommand, readonlyBashCommand } from "./bash-rules.ts";

/**
 * TypeSafe jev prefilter: an independent HTTP API, deliberately separate from the
 * omp model registry that serves `model`/`fallbackModels`. A missing block keeps the
 * prefilter off and leaves the LLM chain exactly as it was.
 */
export interface JevConfig {
  /** Omitted means enabled; the block's presence is what opts in. */
  enabled?: boolean;
  baseUrl: string;
  /** A jev model name or alias such as `jev-latest`; never a `provider/model` spec. */
  model: string;
  /** Environment variable holding the API key; it wins over the inline `apiKey`. */
  apiKeyEnv: string;
  /** Inline key fallback for hosts without environment variables; never echoed. */
  apiKey?: string;
  /** Winning-option probability required to accept jev's verdict without the LLM chain. */
  confidenceThreshold: number;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
}

export interface ReviewConfig {
  /** Master switch; omitted in older configurations means enabled. */
  enabled?: boolean;
  model?: string;
  /** Optional independent prefilter; absent means every reviewed call goes straight to the LLM chain. */
  jev?: JevConfig;
  /** Optional JSONL file; relative paths resolve against the user agent directory. */
  reviewLogPath?: string;
  fallbackModels: string[];
  /** Independent master switch; disabling it preserves the configured rules. */
  bashBypassEnabled?: boolean;
  /** Built-in common read-only preset; `off` leaves only the additional rules. */
  bashReadonlyPreset?: "common" | "off";
  /** Additional complete read-only commands; an empty list does not disable the preset. */
  bashAllowCommands?: readonly string[];
  reviewTimeoutMs: number;
  modelTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  confirmationTimeoutMs: number;
  recommendationTimeoutMs?: number;
  maxOperationBytes: number;
  maxContextBytes: number;
}

export const defaults: Readonly<ReviewConfig> = Object.freeze({
  enabled: true,
  fallbackModels: [],
  bashBypassEnabled: true,
  bashReadonlyPreset: "common",
  bashAllowCommands: Object.freeze([] as string[]),
  reviewTimeoutMs: 20_000,
  modelTimeoutMs: 10_000,
  retryCount: 1,
  retryDelayMs: 500,
  confirmationTimeoutMs: 90_000,
  recommendationTimeoutMs: 15_000,
  maxOperationBytes: 32_768,
  maxContextBytes: 24_576,
});

export const jevDefaults: Readonly<JevConfig> = Object.freeze({
  enabled: true,
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  apiKeyEnv: "TYPESAFE_API_KEY",
  confidenceThreshold: 0.85,
  timeoutMs: 5_000,
  retryCount: 1,
  retryDelayMs: 500,
});

/** Loopback hosts are the only reason to accept plain http: local mock servers in tests. */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseJevConfig(value: unknown): JevConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("jev 必须是 JSON 对象");
  const obj = value as Record<string, unknown>;
  const known = new Set([...Object.keys(jevDefaults), "apiKey"]);
  for (const key of Object.keys(obj)) if (!known.has(key)) throw new Error(`未知 jev 配置字段：${key}`);
  const result: JevConfig = { ...jevDefaults };
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") throw new Error("jev.enabled 必须为布尔值");
    result.enabled = obj.enabled;
  }
  if (obj.baseUrl !== undefined) {
    if (typeof obj.baseUrl !== "string") throw new Error("jev.baseUrl 必须为字符串");
    let url: URL;
    try { url = new URL(obj.baseUrl); } catch { throw new Error("jev.baseUrl 必须是完整的绝对 URL"); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
      throw new Error("jev.baseUrl 必须使用 https；仅回环地址允许 http");
    }
    // Credentials in the URL would be sent on every call and could leak through error text.
    if (url.username || url.password) throw new Error("jev.baseUrl 不能内嵌凭据");
    if (url.search || url.hash) throw new Error("jev.baseUrl 不能包含查询串或片段");
    result.baseUrl = url.toString();
  }
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(obj.model)) {
      throw new Error("jev.model 必须是 jev 模型名或别名（如 jev-latest），不含 provider 前缀");
    }
    result.model = obj.model;
  }
  if (obj.apiKeyEnv !== undefined) {
    if (typeof obj.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(obj.apiKeyEnv)) {
      throw new Error("jev.apiKeyEnv 必须是合法的环境变量名");
    }
    result.apiKeyEnv = obj.apiKeyEnv;
  }
  if (obj.apiKey !== undefined) {
    // Never echo the value itself, here or anywhere else.
    if (typeof obj.apiKey !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,1024}$/.test(obj.apiKey)) {
      throw new Error("jev.apiKey 必须为不含空白字符的非空字符串；建议改用 jev.apiKeyEnv");
    }
    result.apiKey = obj.apiKey;
  }
  if (obj.confidenceThreshold !== undefined) {
    // The 0.5 floor is TypeSafe's own: below it the model reports genuine uncertainty.
    if (typeof obj.confidenceThreshold !== "number" || !Number.isFinite(obj.confidenceThreshold) ||
        obj.confidenceThreshold <= 0.5 || obj.confidenceThreshold > 1) {
      throw new Error("jev.confidenceThreshold 必须是大于 0.5 且不超过 1 的数值");
    }
    result.confidenceThreshold = obj.confidenceThreshold;
  }
  if (obj.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(obj.timeoutMs) || Number(obj.timeoutMs) < 1 || Number(obj.timeoutMs) > 30_000) {
      throw new Error("jev.timeoutMs 必须为 1 到 30000 的整数");
    }
    result.timeoutMs = Number(obj.timeoutMs);
  }
  for (const [key, max] of [["retryCount", 3], ["retryDelayMs", 10_000]] as const) {
    if (obj[key] === undefined) continue;
    if (!Number.isSafeInteger(obj[key]) || Number(obj[key]) < 0 || Number(obj[key]) > max) {
      throw new Error(`jev.${key} 必须为 0 到 ${max} 的整数`);
    }
    result[key] = Number(obj[key]);
  }
  return result;
}

/** Worst-case wall time the prefilter can add, counted into the host's tool-hook budget. */
export function jevBudgetMs(jev: JevConfig | undefined): number {
  if (!jev || jev.enabled === false) return 0;
  return jev.timeoutMs * (jev.retryCount + 1) + jev.retryDelayMs * jev.retryCount;
}

/** Resolves the key with `apiKeyEnv` winning; `source` is safe to display, `key` never is. */
export function jevApiKey(jev: JevConfig): { key?: string; source: "env" | "config" | "none" } {
  const fromEnv = process.env[jev.apiKeyEnv]?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (jev.apiKey) return { key: jev.apiKey, source: "config" };
  return { source: "none" };
}

export function parseConfig(value: unknown): ReviewConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  const obj = value as Record<string, unknown>;
  const known = new Set(["model", "reviewLogPath", "jev", ...Object.keys(defaults)]);
  for (const key of Object.keys(obj)) if (!known.has(key)) throw new Error(`未知配置字段：${key}`);
  // Never share the default array: callers may mutate the parsed result.
  const result = { ...defaults, fallbackModels: [] as string[], bashAllowCommands: [] as string[] };
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") throw new Error("enabled 必须为布尔值");
    result.enabled = obj.enabled;
  }
  if (obj.bashBypassEnabled !== undefined) {
    if (typeof obj.bashBypassEnabled !== "boolean") throw new Error("bashBypassEnabled 必须为布尔值");
    result.bashBypassEnabled = obj.bashBypassEnabled;
  }
  if (obj.bashReadonlyPreset !== undefined) {
    if (obj.bashReadonlyPreset !== "common" && obj.bashReadonlyPreset !== "off") throw new Error("bashReadonlyPreset 必须为 common 或 off");
    result.bashReadonlyPreset = obj.bashReadonlyPreset;
  }
  if (obj.reviewLogPath !== undefined) {
    if (typeof obj.reviewLogPath !== "string" || !obj.reviewLogPath.trim() || obj.reviewLogPath.includes("\0")) {
      throw new Error("reviewLogPath 必须为非空日志文件路径；删除此字段可关闭审查日志");
    }
    result.reviewLogPath = obj.reviewLogPath;
  }
  if (obj.bashAllowCommands !== undefined) {
    if (!Array.isArray(obj.bashAllowCommands) || obj.bashAllowCommands.length > 64 ||
        obj.bashAllowCommands.some(command => typeof command !== "string" || !readonlyBashCommand(command))) {
      throw new Error("bashAllowCommands 必须是最多 64 条支持的只读完整命令，不支持通配符或 shell 组合语法");
    }
    // Store the normalized spelling so rule matching and display agree on one form.
    result.bashAllowCommands = [...new Set((obj.bashAllowCommands as string[]).map(command => normalizeBashCommand(command)!))];
  }
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || !/^[^\s/]+\/\S+$/.test(obj.model)) {
      throw new Error("model 必须是完整的 provider/model");
    }
    result.model = obj.model;
  }
  if (obj.fallbackModels !== undefined) {
    if (!Array.isArray(obj.fallbackModels) || obj.fallbackModels.length > 8 ||
        obj.fallbackModels.some(value => typeof value !== "string" || !/^[^\s/]+\/\S+$/.test(value))) {
      throw new Error("fallbackModels 必须是最多 8 个完整 provider/model 组成的数组");
    }
    // Duplicates would waste the shared budget; the primary is already the first candidate.
    const fallbackModels = [...new Set(obj.fallbackModels as string[])];
    if (obj.model && fallbackModels.includes(obj.model as string)) throw new Error("fallbackModels 不能包含主审核模型");
    result.fallbackModels = fallbackModels;
  }
  if (obj.jev !== undefined) result.jev = parseJevConfig(obj.jev);
  for (const key of ["reviewTimeoutMs", "modelTimeoutMs", "confirmationTimeoutMs", "maxOperationBytes", "maxContextBytes"] as const) {
    if (obj[key] === undefined) continue;
    if (!Number.isSafeInteger(obj[key]) || Number(obj[key]) < 1) throw new Error(`${key} 必须为正整数`);
    result[key] = obj[key] as number;
  }
  if (result.reviewTimeoutMs + result.confirmationTimeoutMs > 110_000) {
    throw new Error("审核与人工确认的总超时不能超过 110000ms（宿主建议 120000ms）");
  }
  // The prefilter shares the review phase instead of extending it: the 110000ms invariant
  // and every existing configuration stay valid, and the LLM chain always keeps some time.
  if (jevBudgetMs(result.jev) >= result.reviewTimeoutMs) {
    throw new Error("jev 前置审查的最坏用时必须小于 reviewTimeoutMs；请调高 reviewTimeoutMs 或降低 jev.timeoutMs/retryCount");
  }
  // Retries and their waits share one model's time share, so both allow 0 and stay bounded.
  for (const [key, max] of [["retryCount", 5], ["retryDelayMs", 10_000]] as const) {
    if (obj[key] === undefined) continue;
    if (!Number.isSafeInteger(obj[key]) || Number(obj[key]) < 0 || Number(obj[key]) > max) {
      throw new Error(`${key} 必须为 0 到 ${max} 的整数`);
    }
    result[key] = Number(obj[key]);
  }
  if (obj.recommendationTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(obj.recommendationTimeoutMs) || Number(obj.recommendationTimeoutMs) < 0 || Number(obj.recommendationTimeoutMs) > 110_000) {
      throw new Error("recommendationTimeoutMs 必须为 0 到 110000 的整数，0 表示关闭自动决策");
    }
    result.recommendationTimeoutMs = Number(obj.recommendationTimeoutMs);
  }
  if (result.maxOperationBytes > 131_072 || result.maxContextBytes > 65_536) throw new Error("上下文预算过大");
  return result;
}

export class ConfigStore {
  readonly path: string;
  constructor(readonly agentDir: string) { this.path = join(agentDir, "auto-review.json"); }
  async load(): Promise<ReviewConfig> {
    try { return parseConfig(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
      // Do not echo config contents or JSON parser excerpts, which may contain secrets.
      throw new Error("auto-review.json 无法读取或配置无效；请检查用户级配置");
    }
  }
  async save(config: ReviewConfig): Promise<void> {
    const checked = parseConfig(config);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, this.path);
  }
}
