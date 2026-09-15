import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AuditRecord } from "./audit.ts";
import { redactValue } from "./privacy.ts";
import type { ToolCall } from "./policy.ts";

/**
 * Optional command-level review log: one redacted JSONL record per reviewed call.
 *
 * Written once a conclusion exists and before human confirmation, so an approval never
 * rewrites the model's verdict; bypassed calls and unconfigured models never reach it.
 * New directories are `0700` and new files `0600`, matching the audit log.
 */
export interface ReviewLogRecord {
  timestamp: string;
  sessionId: string;
  cwd: string;
  /** Redacted snapshot of the reviewed call; full parameters are intentional here. */
  operation: ToolCall;
  model: string | null;
  fallbackUsed: boolean;
  decision: AuditRecord["decision"];
  /** Redacted verdict reason; the chain's own failure summary when no verdict arrived. */
  reason: string;
  recommendation?: AuditRecord["recommendation"];
  /** Per-model attempts, present only when a model call was started. */
  attempts?: AuditRecord["attempts"];
}

/** Appends one record; `path` resolves against the user agent directory and its parent directory is created on demand. */
export async function appendReviewLog(agentDir: string, path: string, record: ReviewLogRecord): Promise<void> {
  const file = resolve(agentDir, path);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(redactValue(record))}\n`, { mode: 0o600 });
}
