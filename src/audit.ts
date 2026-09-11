import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactValue } from "./privacy.ts";

export interface AuditRecord {
  timestamp: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  operationHash: string;
  parameterSummary: { keys: string[]; bytes: number };
  model: string | null;
  decision: "allow" | "deny" | "ask" | "error";
  reason: string;
  outcome: "allowed" | "blocked";
  humanOverride: boolean;
  elapsedMs: number;
}

export async function appendAudit(agentDir: string, record: AuditRecord): Promise<void> {
  const dir = join(agentDir, "auto-review", "audit");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(join(dir, `${record.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(redactValue(record))}\n`, { mode: 0o600 });
}
