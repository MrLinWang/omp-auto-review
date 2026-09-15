/** Fixed categories shown in the confirmation dialog and audit; keep them free of raw provider text. */
export const attemptLabels = {
  running: "审核中", success: "有效结论", timeout: "超时", cancelled: "已取消",
  missing_model: "模型未注册", auth_error: "认证失败", rate_limit: "限流",
  invalid_response: "响应格式无效", output_limit: "输出达到上限",
  call_error: "接口或网络异常", incomplete: "响应未正常完成",
} as const;

export interface ReviewAttempt {
  model: string;
  status: keyof typeof attemptLabels;
  elapsedMs: number;
  /** 1-based call number on this model; recorded only when retries are enabled. */
  attempt?: number;
}
export type AttemptObserver = (attempt: ReviewAttempt) => void;

/** Safe fixed error categories: never expose raw provider responses or credentials. */
export class ReviewAttemptError extends Error {
  constructor(readonly code: Exclude<ReviewAttempt["status"], "running" | "success">) {
    super(attemptLabels[code]);
  }
}

export function attemptErrorCode(error: unknown): ReviewAttempt["status"] {
  if (error instanceof ReviewAttemptError) return error.code;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  return "call_error";
}

export function formatAttempts(attempts: readonly ReviewAttempt[]): string {
  return attempts.map(attempt => `${attempt.model}${attempt.attempt ? ` 第${attempt.attempt}次` : ""}：${attemptLabels[attempt.status]}（${(attempt.elapsedMs / 1000).toFixed(1)}s）`).join(" → ");
}
