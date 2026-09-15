import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ReviewConfig {
  model?: string;
  fallbackModels: string[];
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
  fallbackModels: [],
  reviewTimeoutMs: 20_000,
  modelTimeoutMs: 10_000,
  retryCount: 1,
  retryDelayMs: 500,
  confirmationTimeoutMs: 90_000,
  recommendationTimeoutMs: 15_000,
  maxOperationBytes: 32_768,
  maxContextBytes: 24_576,
});

export function parseConfig(value: unknown): ReviewConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  const obj = value as Record<string, unknown>;
  const known = new Set(["model", ...Object.keys(defaults)]);
  for (const key of Object.keys(obj)) if (!known.has(key)) throw new Error(`未知配置字段：${key}`);
  // Never share the default array: callers may mutate the parsed result.
  const result = { ...defaults, fallbackModels: [] as string[] };
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
  for (const key of ["reviewTimeoutMs", "modelTimeoutMs", "confirmationTimeoutMs", "maxOperationBytes", "maxContextBytes"] as const) {
    if (obj[key] === undefined) continue;
    if (!Number.isSafeInteger(obj[key]) || Number(obj[key]) < 1) throw new Error(`${key} 必须为正整数`);
    result[key] = obj[key] as number;
  }
  if (result.reviewTimeoutMs + result.confirmationTimeoutMs > 110_000) {
    throw new Error("审核与人工确认的总超时不能超过 110000ms（宿主建议 120000ms）");
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
