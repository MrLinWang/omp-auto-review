import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactValue } from "./privacy.ts";
import type { ReviewAttempt } from "./attempt.ts";
import type { PreparationErrorCode } from "./reviewer.ts";

export interface AuditRecord {
  timestamp: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  operationHash: string;
  parameterSummary: { keys: string[]; bytes: number };
  model: string | null;
  /** True when a fallback candidate produced the verdict; `model` then names that model. */
  fallbackUsed?: boolean;
  /** Exact additional rule or stable preset rule identifiers; no raw compound command. */
  bypassRule?: string;
  attempts?: ReviewAttempt[];
  /** Local preparation failed before any model attempt; `model` is null. */
  preflightError?: PreparationErrorCode;
  decision: "allow" | "deny" | "ask" | "error";
  reason: string;
  recommendation?: { action: "approve" | "deny"; reason: string };
  outcome: "allowed" | "blocked";
  humanOverride: boolean;
  automaticRecommendation?: boolean;
  elapsedMs: number;
}

export async function appendAudit(agentDir: string, record: AuditRecord): Promise<void> {
  const dir = join(agentDir, "auto-review", "audit");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, `${record.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(redactValue(record))}\n`, { mode: 0o600 });
}
