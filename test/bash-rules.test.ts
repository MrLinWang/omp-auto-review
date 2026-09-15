import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BASH_ALLOW_COMMANDS, matchBashRule, readonlyBashCommand, hasGitFilters } from "../src/bash-rules.ts";
import { parseConfig, defaults } from "../src/config.ts";
import { classify } from "../src/policy.ts";
import { ReviewEngine } from "../src/engine.ts";
import type { AuditRecord } from "../src/audit.ts";
import { builtin, call, context, workspace } from "./helpers.ts";

test("full-command rules are configurable and validate the supported query grammar", () => {
  assert.deepEqual(parseConfig({}).bashAllowCommands, DEFAULT_BASH_ALLOW_COMMANDS);
  assert.deepEqual(parseConfig({ bashAllowCommands: [] }).bashAllowCommands, []);
  assert.deepEqual(parseConfig({ bashAllowCommands: ["git  status --short", "git status --short", "git diff --cached --stat"] }).bashAllowCommands,
    ["git status --short", "git diff --cached --stat"]);
  for (const rules of [null, "pwd", ["git *"], ["rm -f a"], ["git diff"], ["cat .env"], ["pwd; whoami"], [12], Array(65).fill("pwd")]) {
    assert.throws(() => parseConfig({ bashAllowCommands: rules }));
  }
  for (const command of DEFAULT_BASH_ALLOW_COMMANDS) assert.ok(matchBashRule({ command }, DEFAULT_BASH_ALLOW_COMMANDS));
  assert.equal(matchBashRule({ command: "git status --branch" }, ["git status"]), undefined);
  assert.equal(matchBashRule({ command: "pwd" }, []), undefined);
});

test("shell constructs, paths, config overrides and execution modifiers require review", async () => {
  const commands = ["pwd\n", "pwd; rm a", "pwd && id", "pwd || id", "pwd | cat", "pwd > out", "pwd < file", "pwd &", "$(pwd)", "`pwd`", "pwd # hi", "pwd\\", "'pwd'", '"pwd"', "pwd\t", "pwd\x1b[0m", "env pwd", "A=x pwd", "/bin/pwd", "git -C /tmp status", "git -c core.pager=bad status", "git diff --stat --output=x", "git diff --stat -- .env", "git diff --stat ../a", "git show HEAD:.env", "git status --porcelain=v1; id"];
  for (const command of commands) assert.equal(readonlyBashCommand(command), undefined, command);
  for (const extra of [{ env: {} }, { cwd: "/outside" }, { pty: true }, { async: true }, { script: "bad" }]) {
    assert.equal(matchBashRule({ command: "pwd", ...extra }, ["pwd"]), undefined);
  }
  assert.equal((await classify(call(), "/work", undefined, [], ["pwd"])).review, true);
  assert.equal((await classify(call(), "/work", { name: "bash", sourceInfo: { source: "extension", path: "/x" } }, [], ["pwd"])).review, true);
  const command = readonlyBashCommand("git diff --stat");
  for (const flag of ["--no-pager", "--no-optional-locks", "core.fsmonitor=false", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]) assert.ok(command?.includes(flag));
});

test("bypassed calls are rewritten, audited and never invoke the model; failures block", async () => {
  const w = await workspace();
  try {
    let reviews = 0;
    const records: AuditRecord[] = [];
    const makeEngine = (audit: (record: AuditRecord) => Promise<void>, commands: readonly string[] = ["pwd"]) => new ReviewEngine({
      config: () => ({ ...defaults, model: "test/reviewer", bashAllowCommands: commands }),
      sources: () => [builtin("bash")], protectedRoots: [w.cwd],
      review: async () => { reviews++; return { decision: "deny", risk: "low", authorization: "implicit", reason: "test" }; },
      audit,
    });
    const engine = makeEngine(async record => { records.push(record); });
    assert.deepEqual(await engine.handle(call(), context(w.cwd).ctx), { input: { command: "builtin pwd" } });
    assert.equal(reviews, 0);
    assert.equal(records[0].model, null);
    assert.equal(records[0].bypassRule, "pwd");
    assert.equal((await makeEngine(async () => {}, []).handle(call(), context(w.cwd).ctx))?.block, true);
    assert.equal(reviews, 1);
    assert.equal((await makeEngine(async () => { throw new Error("disk full"); }).handle(call(), context(w.cwd).ctx))?.block, true);
    const event = call();
    assert.equal((await makeEngine(async () => { event.input.command = "rm a"; }).handle(event, context(w.cwd).ctx))?.block, true);
  } finally { await w.cleanup(); }
});

test("hardened git queries suppress configured external helpers and leave the index unchanged", async () => {
  const w = await workspace();
  const exec = promisify(execFile);
  const options = { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } };
  const git = (...args: string[]) => exec("git", args, options);
  try {
    await git("init", "--quiet");
    await writeFile(join(w.cwd, "a.txt"), "old\n");
    await writeFile(join(w.cwd, ".gitattributes"), "*.txt diff=probe\n");
    await git("add", "a.txt", ".gitattributes");
    await writeFile(join(w.cwd, "a.txt"), "new\n");
    await git("config", "core.fsmonitor", "touch fsmonitor-ran");
    await git("config", "diff.external", "touch external-ran");
    await git("config", "diff.probe.textconv", "touch textconv-ran");
    const index = await readFile(join(w.cwd, ".git/index"));
    for (const command of ["git status --short", "git diff --stat"]) {
      const result = await exec("bash", ["--noprofile", "--norc", "-c", readonlyBashCommand(command)!], options);
      assert.ok(result.stdout.includes("a.txt"));
    }
    for (const marker of ["fsmonitor-ran", "external-ran", "textconv-ran"]) {
      await assert.rejects(access(join(w.cwd, marker)), { code: "ENOENT" });
    }
    assert.deepEqual(await readFile(join(w.cwd, ".git/index")), index);
    await git("config", "filter.probe.clean", "touch filter-ran");
    assert.equal(await hasGitFilters(w.cwd), true);
    assert.equal((await classify(call("bash", { command: "git status --short" }), w.cwd, builtin("bash"), [], ["git status --short"])).review, true);
    await assert.rejects(access(join(w.cwd, "filter-ran")), { code: "ENOENT" });
  } finally { await w.cleanup(); }
});
