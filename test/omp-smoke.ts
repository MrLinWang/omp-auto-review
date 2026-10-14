import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, rm, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join, relative } from "node:path";
import assert from "node:assert/strict";

/** Fixed jev answers per scenario; a two-option Choice as the real endpoint returns it. */
const jevReplies: Record<string, { status: number; choice?: "allow" | "deny"; allow?: number; deny?: number; confidence?: number }> = {
  "jev-allow": { status: 200, choice: "allow", allow: 0.96, deny: 0.04, confidence: 0.93 },
  "jev-deny": { status: 200, choice: "deny", allow: 0.02, deny: 0.98, confidence: 0.96 },
  // Deliberately below the 0.85 threshold: the slower reviewer must take over.
  "jev-escalate": { status: 200, choice: "allow", allow: 0.6, deny: 0.4, confidence: 0.3 },
  "jev-only": { status: 200, choice: "allow", allow: 0.62, deny: 0.38, confidence: 0.28 },
  "jev-unavailable": { status: 401 },
  "jev-disabled": { status: 200, choice: "allow", allow: 0.99, deny: 0.01, confidence: 0.99 },
  "jev-redirect": { status: 302 },
  "jev-oversize": { status: 200 },
  "jev-chat-role": { status: 200 },
  "jev-no-key": { status: 200 },
  "jev-quota": { status: 402 },
  "jev-malformed": { status: 200 },
  "jev-invalid-json": { status: 200 },
};

/** Local stand-in for api.typesafe.ai; records each call in the shared trace. */
async function startJevEndpoint(scenario: string, trace: string) {
  const reply = jevReplies[scenario];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const question = Object.keys(body.questions ?? {})[0];
      appendFileSync(trace, `${JSON.stringify({
        role: "prefilter", method: request.method, path: request.url,
        // Record only whether the expected credential arrived, never the value.
        auth: request.headers.authorization === "Bearer smoke-test-key",
        headers: request.headers["x-smoke-provider"] === "native-route" && request.headers["x-smoke-model"] === "judge-only",
        model: body.model, question, criteria: Object.keys(body.questions?.[question]?.criteria ?? {}).sort(),
        command: body.state?.operation?.input?.command, source: body.state?.latestUserInstruction?.source,
      })}\n`);
      if (scenario === "jev-redirect") {
        response.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/redirected-smoke-credential-target` });
        response.end();
        return;
      }
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(scenario === "jev-oversize" ? "x".repeat(64 * 1024 + 1)
        : scenario === "jev-invalid-json" ? "{"
        : scenario === "jev-malformed" ? JSON.stringify({ model: "jev-1.13.0", answers: {} })
        : reply.status === 200 ? JSON.stringify({
          model: "jev-1.13.0",
          answers: { tool_call_decision: { type: "choice", choice: reply.choice, probabilities: { allow: reply.allow, deny: reply.deny }, confidence: reply.confidence } },
          usage: { input_tokens: 120, output_tokens: 8 },
        })
        : JSON.stringify({ error: "invalid api key smoke-test-key" }));
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

const repo = resolve(import.meta.dirname, "..");
const omp = process.env.OMP_BIN || "omp";
const root = await mkdtemp(join(tmpdir(), "omp-review-smoke-"));
console.log(`Smoke artifacts: ${root}`);
let allPassed = false;
try {
  const runtimePackage = join(root, "runtime-package");
  await mkdir(runtimePackage);
  await cp(join(repo, "src"), join(runtimePackage, "src"), { recursive: true });
  await cp(join(repo, "package.json"), join(runtimePackage, "package.json"));
  for (const scenario of (process.env.OMP_SMOKE_CASES?.split(",") ?? ["allow", "deny", "invalid", "missing", "preflight-context-budget", "preflight-operation-budget", "disabled", "native-deny", "native-prompt", "child", "xd", "tui-approve", "tui-reject", "tui-cancel", "tui-auto-approve", "tui-auto-deny", "fallback-invalid", "fallback-timeout", "fallback-missing", "fallback-deny", "fallback-ask", "fallback-all-fail", "retry-invalid", "retry-timeout", "retry-exhausted", "bypass-pwd", "bypass-git", "bypass-git-filter", "bypass-disabled", "bypass-compound", "bypass-safe-compound", "bypass-text", "bypass-extras", "bypass-off-empty", "bypass-native-deny", ...Object.keys(jevReplies)])) {
    const cwd = join(root, scenario, "work"), agentDir = join(root, scenario, "agent");
    await mkdir(cwd, { recursive: true });
    if (scenario.startsWith("bypass-")) {
      await promisify(execFile)("git", ["init", "--quiet", cwd]);
      // A unique payload lets the text scenario prove its pipeline ran, not just any output.
      await writeFile(join(cwd, "visible.txt"), scenario === "bypass-text" ? "pipeline-token-42\n" : "test\n");
      if (scenario === "bypass-git-filter") await promisify(execFile)("git", ["-C", cwd, "config", "filter.probe.clean", "touch filter-ran"]);
    }
    await mkdir(join(agentDir, "agents"), { recursive: true });
    const trace = join(root, scenario, "trace.jsonl");
    await writeFile(trace, "");
    // Native connection and credentials belong to the isolated OMP registry, never auto-review.json.
    const jev = scenario.startsWith("jev-") ? await startJevEndpoint(scenario, trace) : undefined;
    await writeFile(join(agentDir, "config.yml"), `
startup:
  setupWizard: false
  checkUpdate: false
tools:
  approvalMode: yolo
  intentTracing: false
  approval: ${scenario === "native-deny" || scenario === "bypass-native-deny" ? '{bash: deny}' : scenario === "native-prompt" ? '{bash: prompt}' : '{}'}
extensionHandlers:
  toolCallTimeoutMs: 120000
modelRoles:
  task: review-test/child
  ${jev ? `judge: ${scenario === "jev-chat-role" ? "review-test/reviewer" : scenario === "jev-no-key" ? "typesafe/jev-latest" : "review-test/jev-latest"}` : ""}
retry:
  fallbackChains:
    judge: []
async:
  enabled: false
task:
  prewalk: false
  batch: false
  isolation:
    enabled: false
`);
    await writeFile(join(agentDir, "agents", "review-child.md"), "---\nname: review-child\ndescription: Isolated smoke child\nmodel: review-test/child\n---\nRun one bash command then yield.\n");
    if (scenario !== "missing") await writeFile(join(agentDir, "auto-review.json"), JSON.stringify({
      // A jev-only setup deliberately configures no LLM reviewer at all.
      model: scenario === "jev-only" ? undefined : scenario === "fallback-missing" ? "review-test/missing" : "review-test/reviewer",
      ...(jev ? {
        reviewLogPath: "reviews.jsonl",
        jev: {
          confidenceThreshold: 0.85,
          timeoutMs: 2000,
          retryCount: 0,
          retryDelayMs: 0,
          ...(scenario === "jev-disabled" ? { enabled: false } : {}),
        },
      } : {}),
      ...(scenario === "preflight-context-budget" ? { maxContextBytes: 1, reviewLogPath: "reviews.jsonl" } : {}),
      ...(scenario === "preflight-operation-budget" ? { maxOperationBytes: 1, reviewLogPath: "reviews.jsonl" } : {}),
      // The switch is a config value here; a reviewer that would deny proves it was never asked.
      ...(scenario === "disabled" ? { enabled: false, reviewLogPath: "reviews.jsonl" } : {}),
      ...(scenario === "bypass-disabled" ? { bashBypassEnabled: false } : {}),
      ...(scenario === "bypass-extras" ? { bashReadonlyPreset: "off", bashAllowCommands: ["pwd -P"] } : {}),
      ...(scenario === "bypass-off-empty" ? { bashReadonlyPreset: "off", bashAllowCommands: [] } : {}),
      ...(scenario === "bypass-text" ? { bashAllowCommands: [] } : {}),
      ...(scenario.startsWith("fallback-") ? { fallbackModels: ["review-test/backup"], reviewTimeoutMs: 2000 } : {}),
      ...(scenario.startsWith("retry-") ? { fallbackModels: ["review-test/backup"], reviewTimeoutMs: 3000, modelTimeoutMs: 300, retryCount: 1, retryDelayMs: 20 } : {}),
      ...(scenario.startsWith("tui-auto-") ? { recommendationTimeoutMs: 1000 } : {}),
    }));
    const args = ["--cwd", cwd, "--no-extensions", "--extension", join(repo, "test/fixtures/mock-provider.ts"), "--extension", runtimePackage,
      "--model", "review-test/main", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk", "--no-pty", "--no-session",
      "--tools", "bash,task,write", "--thinking", "off", "--mode", "json", "--print", "--max-time", "45",
      "Create marker.txt in this isolated directory using the specified command, and obey review decisions."];
    const isTui = scenario.startsWith("tui-") || scenario === "jev-deny";
    if (isTui) {
      args.splice(args.indexOf("--mode"), 2);
      args.splice(args.indexOf("--print"), 1);
    }
    // Whitelist environment: tests never inherit provider credentials or user model config.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TERM: isTui ? "xterm-256color" : "dumb", LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: agentDir, OMP_REVIEW_TEST_CASE: scenario, OMP_REVIEW_TEST_TRACE: trace,
      OMP_REVIEW_JEV_BASE_URL: jev ? `http://127.0.0.1:${jev.port}` : undefined,
      PI_CONFIG_DIR: relative(homedir(), join(root, scenario, "omp-state")),
      PI_NO_PTY: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    };
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(isTui ? "python3" : omp, isTui ? [join(repo, "test/tui-driver.py"), omp, ...args] : args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", x => { output += x; }); child.stderr.on("data", x => { output += x; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); done({ code, output }); });
    });
    await writeFile(join(root, scenario, "output.txt"), result.output);
    await jev?.close();
    assert.equal(result.code, 0, `${scenario}: omp failed\n${result.output.slice(-6000)}`);
    assert.ok(result.output.includes("SMOKE_DONE"), `${scenario}: main agent did not finish\n${result.output.slice(-4000)}`);
    const marker = await access(join(cwd, "marker.txt")).then(() => true, () => false);
    assert.equal(marker, ["allow", "disabled", "tui-approve", "tui-auto-approve", "fallback-invalid", "fallback-timeout", "fallback-missing", "retry-invalid", "retry-timeout", "retry-exhausted", "jev-allow", "jev-escalate", "jev-unavailable", "jev-disabled", "jev-redirect", "jev-oversize", "jev-chat-role", "jev-no-key", "jev-quota", "jev-malformed", "jev-invalid-json"].includes(scenario), `${scenario}: unexpected command execution`);
    const events = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const auditDir = join(agentDir, "auto-review", "audit");
    const auditFiles = await readdir(auditDir).catch(() => []);
    const audit = (await Promise.all(auditFiles.map(file => readFile(join(auditDir, file), "utf8")))).join("");
    if (["allow", "deny", "invalid"].includes(scenario)) assert.ok(events.some(e => e.role === "review" && e.tool === "bash"), "review model was not called");
    if (!["native-deny", "bypass-native-deny", "disabled"].includes(scenario)) assert.ok(audit.includes('"toolName":"bash"') || scenario === "child", "audit missing");
    if (scenario === "disabled") {
      assert.ok(!events.some(event => event.role === "review"), "disabled review still called the model");
      assert.equal(audit, "", "disabled review wrote an audit record");
      assert.equal(await access(join(agentDir, "reviews.jsonl")).then(() => true, () => false), false, "disabled review wrote the review log");
    }
    if (scenario.startsWith("preflight-")) {
      assert.ok(!events.some(event => event.role === "review"), "preparation failure invoked the reviewer");
      const record = audit.trim().split("\n").map(line => JSON.parse(line)).find(record => record.toolName === "bash");
      const code = scenario === "preflight-context-budget" ? "user_instruction_too_large" : "operation_too_large";
      assert.equal(record.preflightError, code);
      assert.equal(record.decision, "error");
      assert.equal(record.model, null);
      assert.equal(record.attempts, undefined);
      const logged = JSON.parse((await readFile(join(agentDir, "reviews.jsonl"), "utf8")).trim());
      assert.equal(logged.preflightError, code);
      assert.equal(logged.model, null);
      assert.equal(logged.reason, record.reason);
      assert.ok(result.output.includes(record.reason), "tool error lost preparation reason");
    }
    if (["bypass-pwd", "bypass-git", "bypass-safe-compound", "bypass-text", "bypass-extras"].includes(scenario)) {
      assert.ok(!events.some(event => event.role === "review"), "bypass invoked reviewer");
      assert.ok(audit.includes('"bypassRule":'), "bypass audit missing");
      assert.ok(audit.includes('"model":null'), "bypass claimed a model review");
    }
    if (scenario === "bypass-git") {
      assert.ok(result.output.includes("visible.txt"), "git query did not execute");
      assert.ok(result.output.includes("--no-pager"), "git query was not hardened");
    }
    if (scenario === "bypass-text") assert.ok(result.output.includes("pipeline-token-42"), "text pipeline did not execute");
    if (scenario === "bypass-safe-compound") assert.ok(result.output.includes("--no-pager"), "compound Git query was not hardened");
    if (scenario === "bypass-native-deny") {
      assert.ok(!result.output.includes("visible.txt"), "bypass ignored native deny");
      assert.ok(!events.some(event => event.role === "review"), "native deny should short-circuit review");
    }
    if (["bypass-disabled", "bypass-compound", "bypass-off-empty"].includes(scenario)) assert.ok(events.some(event => event.role === "review"), "non-exempt command skipped reviewer");
    if (scenario === "bypass-git-filter") {
      assert.ok(events.some(event => event.role === "review"), "configured Git filter skipped reviewer");
      assert.ok(!audit.includes('"bypassRule":'), "filtered repository incorrectly exempted");
    }
    if (isTui) assert.ok(audit.includes(`"humanOverride":${scenario === "tui-approve"}`), "incorrect human override audit");
    if (scenario.startsWith("tui-auto-")) assert.ok(audit.includes('"automaticRecommendation":true'), "automatic recommendation audit missing");
    if (["fallback-invalid", "fallback-timeout", "fallback-missing"].includes(scenario)) {
      assert.ok(events.some(e => e.role === "review" && e.model === "backup"), "fallback not called");
      assert.ok(audit.includes('"model":"review-test/backup"') && audit.includes('"fallbackUsed":true'), "actual reviewer not audited");
    }
    if (["fallback-deny", "fallback-ask"].includes(scenario)) {
      assert.ok(!events.some(e => e.role === "review" && e.model === "backup"), "valid verdict incorrectly triggered fallback");
    }
    if (scenario === "fallback-all-fail") {
      assert.ok(events.some(e => e.role === "review" && e.model === "backup"), "fallback not attempted");
      assert.ok(audit.includes('"decision":"error"'), "failed chain not audited as error");
      const record = audit.trim().split("\n").map(line => JSON.parse(line)).find(record => record.toolName === "bash");
      assert.equal(record.model, "review-test/backup");
      assert.deepEqual(record.attempts.map((attempt: { model: string; status: string }) => [attempt.model, attempt.status]), [
        ["review-test/reviewer", "invalid_response"], ["review-test/reviewer", "invalid_response"],
        ["review-test/backup", "invalid_response"], ["review-test/backup", "invalid_response"],
      ]);
    }
    if (scenario.startsWith("retry-")) {
      const record = audit.trim().split("\n").map(line => JSON.parse(line)).find(record => record.toolName === "bash");
      assert.deepEqual(record.attempts.slice(0, 2).map((attempt: { attempt: number }) => attempt.attempt), [1, 2]);
      assert.equal(record.attempts[0].status, scenario === "retry-timeout" ? "timeout" : "invalid_response");
      assert.equal(record.model, scenario === "retry-exhausted" ? "review-test/backup" : "review-test/reviewer");
      assert.equal(events.filter(event => event.role === "review" && event.model === "reviewer").length, 2);
      assert.equal(record.attempts.length, scenario === "retry-exhausted" ? 3 : 2);
    }
    if (scenario === "child") {
      assert.ok(events.some(e => e.role === "session" && e.model === "child"), "child session did not load extensions");
      assert.ok(events.some(e => e.role === "review" && e.tool === "task"), "task dispatch was not reviewed");
      assert.ok(events.some(e => e.role === "review" && e.tool === "bash"), "child bash was not reviewed");
      assert.ok(audit.includes('"outcome":"blocked"'), "child deny not audited");
    }
    if (scenario === "xd") {
      assert.ok(events.some(e => e.role === "review" && e.tool === "write"), "outer write dispatch bypassed review");
      assert.ok(events.some(e => e.role === "review" && e.tool === "bash"), "nested bash bypassed review");
    }
    if (scenario.startsWith("jev-")) {
      const calls = events.filter(event => event.role === "prefilter");
      const record = audit.trim().split("\n").map(line => JSON.parse(line)).find(record => record.toolName === "bash");
      const llmUsed = events.some(event => event.role === "review" && event.model === "reviewer");
      if (["jev-disabled", "jev-chat-role", "jev-no-key"].includes(scenario)) {
        assert.equal(calls.length, 0, `${scenario}: prefilter should not be contacted`);
        assert.equal(record.prefilter, undefined, `${scenario}: an unattempted prefilter produced a record`);
        assert.ok(llmUsed, `${scenario}: the LLM chain should decide`);
        assert.equal(record.model, "review-test/reviewer");
        assert.deepEqual(record.attempts.map((attempt: { model: string; status: string }) => [attempt.model, attempt.status]), [["review-test/reviewer", "success"]]);
      } else {
        if (["jev-redirect", "jev-oversize"].includes(scenario)) {
          // SDK transport retries remain inside one bounded plugin attempt.
          assert.ok(calls.length >= 1 && calls.length <= 3, `unbounded SDK retries: ${calls.length}`);
        } else assert.equal(calls.length, 1, `prefilter call count ${calls.length}`);
        for (const call of calls) {
          assert.equal(call.method, "POST");
          assert.equal(call.path, "/v1/systemone", "a redirect target was contacted");
          assert.equal(call.auth, true, "OMP did not resolve the native bearer credential");
          assert.equal(call.headers, true, "OMP did not resolve provider and model headers");
          assert.equal(call.model, "jev-latest");
          assert.equal(call.question, "tool_call_decision");
          assert.deepEqual(call.criteria, ["allow", "deny"]);
          assert.ok(String(call.command).includes("marker.txt"), "prefilter did not receive the operation");
          assert.equal(call.source, "user_message");
        }
      }
      if (["jev-allow", "jev-deny"].includes(scenario)) {
        assert.ok(!llmUsed, "a trusted prefilter verdict still called the LLM chain");
        assert.equal(record.model, "jev:review-test/jev-1.13.0");
        assert.equal(record.prefilter.status, "decided");
        assert.equal(record.prefilter.trusted, true);
        assert.equal(record.decision, scenario === "jev-allow" ? "allow" : "deny");
        assert.equal(record.outcome, scenario === "jev-allow" ? "allowed" : "blocked");
        assert.deepEqual(record.attempts.map((attempt: { model: string; status: string }) => [attempt.model, attempt.status]), [["jev:review-test/jev-latest", "success"]]);
      }
      if (scenario === "jev-allow") assert.equal(record.prefilter.probability, 0.96);
      // A trusted deny blocks with no human window; the TUI driver fails if a dialog appears.
      if (scenario === "jev-deny") {
        assert.equal(record.humanOverride, false);
        assert.equal(record.automaticRecommendation, undefined);
      }
      const fallbackStatus: Record<string, string> = {
        "jev-escalate": "success", "jev-unavailable": "auth_error", "jev-quota": "auth_error",
        "jev-redirect": "call_error", "jev-oversize": "output_limit", "jev-malformed": "invalid_response", "jev-invalid-json": "invalid_response",
      };
      if (Object.hasOwn(fallbackStatus, scenario)) {
        assert.ok(llmUsed, `${scenario} did not fall through to the LLM chain`);
        assert.equal(record.model, "review-test/reviewer");
        assert.equal(record.decision, "allow");
        assert.equal(record.prefilter.trusted, false);
        assert.equal(record.prefilter.status, scenario === "jev-escalate" ? "escalated" : "unavailable");
        assert.deepEqual(record.attempts.map((attempt: { model: string; status: string }) => [attempt.model, attempt.status]), [
          ["jev:review-test/jev-latest", fallbackStatus[scenario]], ["review-test/reviewer", "success"],
        ]);
      }
      if (scenario === "jev-escalate") assert.equal(record.prefilter.confidence, 0.3);
      if (scenario === "jev-unavailable") assert.equal(record.prefilter.decision, undefined);
      if (scenario === "jev-only") {
        assert.ok(!llmUsed, "a jev-only setup called an LLM reviewer");
        assert.equal(record.decision, "error");
        assert.equal(record.preflightError, "prefilter_low_confidence");
        assert.equal(record.model, "jev:review-test/jev-latest");
        assert.equal(record.prefilter.status, "escalated");
        assert.equal(record.attempts.length, 1);
        assert.ok(result.output.includes(record.reason), "tool error lost the prefilter reason");
      }
      const reviewLog = await readFile(join(agentDir, "reviews.jsonl"), "utf8");
      const logged = JSON.parse(reviewLog.trim());
      assert.equal(logged.prefilter?.status, record.prefilter?.status);
      assert.equal(logged.decision, record.decision);
      assert.ok(String(logged.operation.input.command).includes("marker.txt"));
      for (const text of [audit, reviewLog]) {
        assert.ok(!text.includes("smoke-test-key"), "diagnostics leaked the native credential");
        assert.ok(!text.includes("127.0.0.1"), "diagnostics leaked the native endpoint");
        assert.ok(!text.includes("redirected-smoke-credential-target"), "diagnostics leaked the redirect location");
      }
    }
    console.log(`PASS ${scenario}`);
  }
  allPassed = true;
} finally {
  if (allPassed && !process.env.KEEP_SMOKE_ARTIFACTS) await rm(root, { recursive: true, force: true });
  else console.log(`Artifacts retained: ${root}`);
}
