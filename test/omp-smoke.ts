import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, rm, cp } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join, relative } from "node:path";
import assert from "node:assert/strict";

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
  for (const scenario of (process.env.OMP_SMOKE_CASES?.split(",") ?? ["allow", "deny", "invalid", "missing", "native-deny", "native-prompt", "child", "xd", "tui-approve", "tui-reject", "tui-cancel"])) {
    const cwd = join(root, scenario, "work"), agentDir = join(root, scenario, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agentDir, "agents"), { recursive: true });
    const trace = join(root, scenario, "trace.jsonl");
    await writeFile(trace, "");
    await writeFile(join(agentDir, "config.yml"), `
startup:
  setupWizard: false
  checkUpdate: false
tools:
  approvalMode: yolo
  intentTracing: false
  approval: ${scenario === "native-deny" ? '{bash: deny}' : scenario === "native-prompt" ? '{bash: prompt}' : '{}'}
extensionHandlers:
  toolCallTimeoutMs: 120000
modelRoles:
  task: review-test/child
async:
  enabled: false
task:
  prewalk: false
  batch: false
  isolation:
    enabled: false
`);
    await writeFile(join(agentDir, "agents", "review-child.md"), "---\nname: review-child\ndescription: Isolated smoke child\nmodel: review-test/child\n---\nRun one bash command then yield.\n");
    if (scenario !== "missing") await writeFile(join(agentDir, "auto-review.json"), JSON.stringify({ model: "review-test/reviewer" }));
    const args = ["--cwd", cwd, "--no-extensions", "--extension", join(repo, "test/fixtures/mock-provider.ts"), "--extension", runtimePackage,
      "--model", "review-test/main", "--no-skills", "--no-rules", "--no-lsp", "--no-title", "--no-prewalk", "--no-pty", "--no-session",
      "--tools", "bash,task,write", "--thinking", "off", "--mode", "json", "--print", "--max-time", "45",
      "Create marker.txt in this isolated directory using the specified command, and obey review decisions."];
    const isTui = scenario.startsWith("tui-");
    if (isTui) {
      args.splice(args.indexOf("--mode"), 2);
      args.splice(args.indexOf("--print"), 1);
    }
    // Whitelist environment: tests never inherit provider credentials or user model config.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TERM: isTui ? "xterm-256color" : "dumb", LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: agentDir, OMP_REVIEW_TEST_CASE: scenario, OMP_REVIEW_TEST_TRACE: trace,
      PI_CONFIG_DIR: relative(homedir(), join(root, scenario, "omp-state")),
      PI_NO_PTY: "1",
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
    assert.equal(result.code, 0, `${scenario}: omp failed\n${result.output.slice(-6000)}`);
    assert.ok(result.output.includes("SMOKE_DONE"), `${scenario}: main agent did not finish\n${result.output.slice(-4000)}`);
    const marker = await access(join(cwd, "marker.txt")).then(() => true, () => false);
    assert.equal(marker, scenario === "allow" || scenario === "tui-approve", `${scenario}: unexpected command execution`);
    const events = (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const auditDir = join(agentDir, "auto-review", "audit");
    const auditFiles = await readdir(auditDir).catch(() => []);
    const audit = (await Promise.all(auditFiles.map(file => readFile(join(auditDir, file), "utf8")))).join("");
    if (["allow", "deny", "invalid"].includes(scenario)) assert.ok(events.some(e => e.role === "review" && e.tool === "bash"), "review model was not called");
    if (scenario !== "native-deny") assert.ok(audit.includes('"toolName":"bash"') || scenario === "child", "audit missing");
    if (isTui) assert.ok(audit.includes(`"humanOverride":${scenario === "tui-approve"}`), "incorrect human override audit");
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
    console.log(`PASS ${scenario}`);
  }
  allPassed = true;
} finally {
  if (allPassed && !process.env.KEEP_SMOKE_ARTIFACTS) await rm(root, { recursive: true, force: true });
  else console.log(`Artifacts retained: ${root}`);
}
