import type { AuditRecord } from "./audit.ts";
import type { ToolCall } from "./policy.ts";
import { redact, safeText } from "./privacy.ts";

/** `model` is carried only when a fallback candidate decided, so the label can name it. */
export type ReviewResult = Pick<AuditRecord, "decision" | "outcome" | "humanOverride" | "automaticRecommendation" | "fallbackUsed" | "bypassRule"> & { model?: string | null };

/** Label for the last completed review; rule-bypassed calls are labelled as such, and automatic decisions are never shown as human approvals. */
export function reviewStatus(operation: ToolCall, result: ReviewResult): string {
  const label = result.bypassRule ? "规则免审" : result.automaticRecommendation
    ? result.outcome === "allowed" ? "超时按建议放行" : "超时按建议拒绝"
    : result.outcome === "allowed"
    ? result.humanOverride ? "人工放行" : "审核通过"
    : result.decision === "error" ? "审核异常，已阻止"
    : result.decision === "deny" ? "审核拒绝" : "未放行";
  const input = operation.input;
  // Summarize only the operation, never file contents or arbitrary tool payloads.
  const detail = typeof input.command === "string" ? input.command
    : typeof input.path === "string" ? input.path : "";
  const summary = safeText(redact(`${operation.toolName}${detail ? `: ${detail}` : ""}`))
    .replace(/\s+/g, " ").trim();
  const chars = Array.from(summary);
  const fallback = result.fallbackUsed ? `（备用：${safeText(redact(result.model ?? "未知"))}）` : "";
  // The fallback marker precedes the summary so a truncated summary never hides it.
  return `${label}${fallback} · ${chars.length > 100 ? `${chars.slice(0, 99).join("")}…` : summary}`;
}
