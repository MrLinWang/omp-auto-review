import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolCall } from "../src/policy.ts";

export async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "omp-review-test-"));
  const cwd = join(root, "work");
  await mkdir(cwd);
  return { root, cwd, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export const builtin = (name: string) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } });
export const call = (toolName = "bash", input: Record<string, unknown> = { command: "pwd" }, toolCallId = "call-1"): ToolCall => ({ toolName, input, toolCallId });
export const userHistory = [{ type: "message", message: { role: "user", content: "请检查项目并运行测试，不要删除我的文件。" } }];
export function context(cwd: string, select?: (...args: any[]) => Promise<string | undefined>) {
  let sessionId = "session-1";
  const ctx = {
    cwd, mode: select ? "tui" : "print", hasUI: Boolean(select),
    sessionManager: { getSessionId: () => sessionId, getBranch: () => userHistory },
    ui: { select },
  } as unknown as ExtensionContext;
  return { ctx, switchSession: () => { sessionId = "session-2"; } };
}
