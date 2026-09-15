// Loaded only by the isolated real-OMP smoke suite. No network or real credentials.
import { appendFileSync } from "node:fs";
import { createMockModel, Effort, type Api, type MockResponse } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function mockProvider(pi: ExtensionAPI) {
  const scenario = process.env.OMP_REVIEW_TEST_CASE!;
  const reviewCounts = new Map<string, number>();
  pi.registerProvider("review-test", {
    baseUrl: "https://example.invalid", apiKey: "local-test-credential", api: "review-test-api" as Api,
    models: ["main", "reviewer", "backup", "child"].map(id => ({
      id, name: id, reasoning: id === "backup" || (id === "reviewer" && scenario === "allow"), input: ["text"] as "text"[],
      ...(id === "backup" || (id === "reviewer" && scenario === "allow") ? {
        thinking: { mode: "effort" as const, efforts: [Effort.Max, Effort.High] },
      } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096,
    })),
    streamSimple(model, ctx, options) {
      let response: MockResponse;
      if (model.id === "reviewer" || model.id === "backup") {
        if (options?.reasoning !== (model.id === "backup" || scenario === "allow" ? Effort.High : undefined)) {
          throw new Error("Reviewer did not select the model's minimum supported effort");
        }
        if (ctx.tools?.length) throw new Error("Reviewer must not have tools");
        const input = JSON.parse(String(ctx.messages[0].content));
        // Keyed per model and call so retry scenarios can change behavior between attempts.
        const countKey = `${model.id}:${input.operation.toolCallId}`;
        const attempt = (reviewCounts.get(countKey) ?? 0) + 1;
        reviewCounts.set(countKey, attempt);
        if (scenario === "child" && input.operation.toolName === "bash" && input.latestUserInstruction?.source !== "ancestor_user_message") {
          throw new Error("Child reviewer did not receive verified ancestor user context");
        }
        appendFileSync(process.env.OMP_REVIEW_TEST_TRACE!, JSON.stringify({ role: "review", model: model.id, attempt, tool: input.operation.toolName, input: input.operation.input }) + "\n");
        const denied = scenario === "deny" || scenario === "fallback-deny" || ["bypass-disabled", "bypass-compound"].includes(scenario) || scenario.startsWith("tui-") || (["child", "xd"].includes(scenario) && input.operation.toolName === "bash");
        const invalid = scenario === "invalid" || scenario === "fallback-all-fail" ||
          (model.id === "reviewer" && (scenario === "fallback-invalid" || scenario === "retry-exhausted" || (scenario === "retry-invalid" && attempt === 1)));
        response = { content: [invalid ? "not JSON" : JSON.stringify({
          decision: scenario.startsWith("tui-") || scenario === "fallback-ask" ? "ask" : denied ? "deny" : "allow", risk: "low", authorization: "explicit", reason: denied ? "测试拒绝" : "测试批准",
          ...(scenario.startsWith("tui-") ? { recommendation: { action: scenario === "tui-auto-deny" ? "deny" : "approve", reason: "隔离测试目录内的测试建议" } } : {}),
        })] };
        if (model.id === "reviewer" && scenario === "fallback-timeout") response.delayMs = 5000;
        if (model.id === "reviewer" && scenario === "retry-timeout" && attempt === 1) response.delayMs = 5000;
      } else {
        const results = ctx.messages.filter(m => m.role === "toolResult");
        // Parent histories can be inherited by children; count only our own bash result.
        const ownDone = model.id === "child" ? results.some(m => m.toolName === "bash") : results.length > 0;
        if (ownDone) response = model.id === "child"
          ? { content: [{ type: "toolCall", name: "yield", arguments: { message: "child done" } }] }
          : { content: ["SMOKE_DONE"] };
        else if (model.id === "main" && scenario === "child") response = { content: [{ type: "toolCall", name: "task", arguments: {
          agent: "task", task: "Run the isolated marker command; obey tool rejection.", isolated: false,
        } }] };
        else if (scenario === "xd") response = { content: [{ type: "toolCall", name: "write", arguments: {
          path: "xd://bash", content: JSON.stringify({ command: "printf reviewed > marker.txt" }),
        } }] };
        else if (scenario.startsWith("bypass-")) response = { content: [{ type: "toolCall", name: "bash", arguments: {
          command: ["bypass-git", "bypass-git-filter", "bypass-native-deny"].includes(scenario) ? "git status --short" : scenario === "bypass-compound" ? "pwd; printf reviewed > marker.txt" : "pwd",
        } }] };
        else response = { content: [{ type: "toolCall", name: "bash", arguments: {
          command: "printf reviewed > marker.txt",
        } }] };
      }
      const mock = createMockModel({ id: model.id, provider: model.provider, responses: [response] });
      return mock.stream(model, ctx, options);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    appendFileSync(process.env.OMP_REVIEW_TEST_TRACE!, JSON.stringify({ role: "session", sessionId: ctx.sessionManager.getSessionId(), model: ctx.model?.id, mode: ctx.mode, tools: pi.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })) }) + "\n");
  });
}
