import type { AuditRecord } from "./audit.ts";
import type { ToolCall } from "./policy.ts";
import { redact, safeText } from "./privacy.ts";

export type ReviewResult = Pick<AuditRecord, "decision" | "outcome" | "humanOverride" | "automaticRecommendation">;

/** Label for the last completed review; automatic decisions are never shown as human approvals. */
export function reviewStatus(operation: ToolCall, result: ReviewResult): string {
  const label = result.automaticRecommendation
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
  return `${label} · ${chars.length > 100 ? `${chars.slice(0, 99).join("")}…` : summary}`;
}
