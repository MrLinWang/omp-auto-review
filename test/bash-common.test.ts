import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, symlink, access, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseLiteralBash } from "../src/bash-parser.ts";
import { parseConfig } from "../src/config.ts";
import { classify } from "../src/policy.ts";
import { ReviewEngine } from "../src/engine.ts";
import { workspace, builtin, call, context } from "./helpers.ts";
import type { AuditRecord } from "../src/audit.ts";

// Isolate policy Git probes as well as subprocess fixtures from user Git filters.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const exec = promisify(execFile);

test("master switch, preset and additive rules are independent", async () => {
  const w = await workspace();
  try {
    const cases = [
      [{}, "pwd", false],
      [{ bashAllowCommands: [] }, "pwd", false],
      [{ bashAllowCommands: ["git status"] }, "pwd", false],
      [{ bashReadonlyPreset: "off" }, "pwd", true],
      [{ bashReadonlyPreset: "off", bashAllowCommands: ["pwd"] }, "pwd", false],
      [{ bashReadonlyPreset: "off", bashAllowCommands: ["pwd"] }, "pwd && pwd", true],
      [{ bashAllowCommands: ["pwd"] }, "pwd && pwd", false],
      [{ bashBypassEnabled: false, bashAllowCommands: ["pwd"] }, "pwd", true],
      [{ bashBypassEnabled: false, bashReadonlyPreset: "off", bashAllowCommands: ["pwd"] }, "pwd", true],
    ] as const;
    for (const [raw, command, review] of cases) {
      const config = parseConfig(raw);
      const result = await classify(call("bash", { command }), w.cwd, builtin("bash"), [], config.bashAllowCommands, config.bashReadonlyPreset, config.bashBypassEnabled);
      assert.equal(result.review, review, JSON.stringify([raw, command]));
    }
    for (const raw of [{ bashBypassEnabled: "true" }, { bashBypassEnabled: null }, { bashReadonlyPreset: true }, { bashReadonlyPreset: "all" }]) assert.throws(() => parseConfig(raw));
    assert.equal(parseConfig({ bashAllowCommands: [] }).bashReadonlyPreset, "common");
    assert.equal(parseConfig({}).bashBypassEnabled, true);
    // A missing cwd cannot trigger a Git probe when the master switch is off.
    assert.match((await classify(call("bash", { command: "git status" }), "/missing", builtin("bash"), [], [], "common", false)).reason, /总开关已关闭/);
  } finally { await w.cleanup(); }
});

test("preset rule identifiers stay stable, unambiguous and free of raw arguments", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.cwd, "a.txt"), "a\n");
    const ids = async (command: string) => {
      const config = parseConfig({});
      const result = await classify(call("bash", { command }), w.cwd, builtin("bash"), [], config.bashAllowCommands, config.bashReadonlyPreset, config.bashBypassEnabled);
      assert.equal(result.review, false, command);
      return result.bypassRule;
    };
    // The preset id is a stable name, never the matched argument text.
    assert.equal(await ids("git --version"), "common:git-version");
    assert.equal(await ids("true"), "common:noop");
    assert.equal(await ids(":"), "common:noop");
    assert.equal(await ids("git status -sb"), "common:git-status");
    // `+` joins compound ids and never occurs inside one, so segments stay separable.
    assert.equal(await ids("cat a.txt | head -n 1"), "common:cat+common:head");
  } finally { await w.cleanup(); }
});

test("literal parser retains operator identity, empty arguments and quoted metacharacters", () => {
  assert.deepEqual(parseLiteralBash(`printf '%s' '' && echo 'a;b' | wc -c; true`), [
    { argv: ["printf", "%s", ""], next: "&&" }, { argv: ["echo", "a;b"], next: "|" },
    { argv: ["wc", "-c"], next: ";" }, { argv: ["true"] },
  ]);
  for (const command of ["pwd\n", "pwd || pwd", "pwd &", "pwd |& pwd", "pwd;;pwd", "pwd &&", "pwd;", "(pwd)", "pwd > f", "pwd < f", "$(pwd)", "`pwd`", "echo \"$HOME\"", "echo 'open", "echo \\", "pwd #comment", "echo *", "pwd\x1b", "pwd\r", Array(65).fill("pwd").join(";"), `echo '${"中".repeat(3000)}'`]) {
    assert.equal(parseLiteralBash(command), undefined, command.slice(0, 100));
  }
});

test("common queries execute literal paths and pipelines with shell-compatible status", async () => {
  const w = await workspace();
  const options = { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } };
  try {
    await exec("git", ["init", "--quiet"], options);
    await writeFile(join(w.cwd, "a file.txt"), "one\ntwo\nthree\n");
    await writeFile(join(w.cwd, "quote'file.txt"), "literal\n");
    await writeFile(join(w.cwd, "-n"), "dash\n");
    const commands = [
      "pwd", "git status -sb", "git status -bs", "git status --porcelain=v1", "git diff --stat", "git ls-files", "git branch --show-current", "git branch -a -v",
      `cd '${w.cwd}' && echo 'title;literal' && cat 'a file.txt' | head -n 2`,
      "cat \"a file.txt\" | tail -n 1", "head -2 'a file.txt'", "wc -lc 'a file.txt'", "grep -nE 'one|two' 'a file.txt'", "sed -n '1,2p' 'a file.txt'",
      "ls -lah .", "stat 'a file.txt'", "cat 'a file.txt' | sort | uniq -c", "printf '%s\\n' 'safe' | cat | wc -l", "echo ''", "true; :",
      'cat "quote\'file.txt"', "cat -- -n", "grep -F -- '-option' 'a file.txt'; true",
      "grep absent 'a file.txt' && echo skipped; echo done", "grep absent 'a file.txt' | wc -l", "printf '%s' '$(touch injected)'",
    ];
    for (const command of commands) {
      const result = await classify(call("bash", { command }), w.cwd, builtin("bash"), [], [], "common");
      assert.equal(result.review, false, command);
      const original = await exec("bash", ["--noprofile", "--norc", "-c", command], options);
      const hardened = await exec("bash", ["--noprofile", "--norc", "-c", result.bashCommand!], options);
      // Git branch coloring/layout is allowed to differ only if user configuration asks for it;
      // this isolated environment has no such settings.
      assert.equal(hardened.stdout.replaceAll(`${w.cwd}/`, ""), original.stdout, command);
    }
    const failing = await classify(call("bash", { command: "grep absent 'a file.txt' && echo skipped" }), w.cwd, builtin("bash"), [], [], "common");
    await assert.rejects(exec("bash", ["-c", failing.bashCommand!], options), { code: 1 });
    await assert.rejects(access(join(w.cwd, "injected")), { code: "ENOENT" });
  } finally { await w.cleanup(); }
});

test("unsafe segments, indirect inputs, execution modifiers and path escapes stay reviewed", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.cwd, "a.txt"), "safe\n");
    await writeFile(join(w.cwd, ".env"), "private\n");
    await mkdir(join(w.cwd, "protected"));
    await writeFile(join(w.cwd, "protected/a.txt"), "private\n");
    await writeFile(join(w.root, "outside"), "outside\n");
    await symlink(join(w.root, "outside"), join(w.cwd, "escape"));
    await symlink(join(w.cwd, ".env"), join(w.cwd, "secret-link"));
    await symlink(join(w.cwd, "missing"), join(w.cwd, "dangling"));
    await symlink(w.cwd, join(w.cwd, "-"));
    await symlink(w.cwd, join(w.cwd, "-P"));
    await exec("mkfifo", [join(w.cwd, "fifo")]);
    const commands = [
      "git status -sb; rm -rf x", "git log --output=x", "git log HEAD", "git -c core.pager=x status", "git branch -D main", "git diff", "git config --get-regexp .", "git show HEAD:.env",
      "sed -i '1p' a.txt", "sed -n '1e' a.txt", "sed -n '1p;w out' a.txt", "sed -n '1p' --follow-symlinks a.txt",
      "grep -r x .", "grep -f .env a.txt", "cat --help", "head -n 1 --help", "tail -f a.txt", "ls -R .", "find . -name x", "awk 'BEGIN{system(\"id\")}'", "echo x > out",
      "cat .env", "cat secret-link", "cat escape", "cat dangling", "cat fifo", "cat protected/a.txt", "cat .", "cat missing", "cat ../outside", "ls ../../..", "stat /dev/null",
      "cat", "head -n 1", "grep x", "cat -", "sort a.txt", "cat a.txt | sort -o out", "cat a.txt | uniq --help", "cat a.txt | grep -f .env", "cat a.txt | head -n 1; cat",
      "printf -v PATH '%s' x", "printf '%b' x", "echo -e x", "echo '\\c'", "true x", "A=x pwd", "env pwd", "command pwd", "for x in a; do pwd; done", "pwd && cd .", "cd .. && pwd", "cd .; pwd", "cd . | pwd", "cd - && pwd", "cd -P && pwd",
      "'git status'", "git 'status --short'", "git status '--short --branch'", "git status --ignored=matching",
    ];
    for (const command of commands) {
      assert.equal((await classify(call("bash", { command }), w.cwd, builtin("bash"), [join(w.cwd, "protected")], [], "common")).review, true, command);
    }
    for (const extra of [{ env: {} }, { cwd: w.cwd }, { pty: false }, { async: false }]) {
      assert.equal((await classify(call("bash", { command: "pwd", ...extra }), w.cwd, builtin("bash"), [], [], "common")).review, true);
    }
  } finally { await w.cleanup(); }
});

test("Git log disables signature helpers and compounds honor filter checks without index writes", async () => {
  const w = await workspace();
  const options = { cwd: w.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } };
  const git = (...args: string[]) => exec("git", args, options);
  try {
    await git("init", "--quiet");
    await writeFile(join(w.cwd, "a.txt"), "a\n");
    await git("add", "a.txt");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "test");
    const tree = (await git("rev-parse", "HEAD^{tree}")).stdout.trim();
    const objectFile = join(w.root, "signed-commit");
    await writeFile(objectFile, `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`);
    const object = (await git("hash-object", "-t", "commit", "-w", objectFile)).stdout.trim();
    await git("update-ref", "HEAD", object);
    const helper = join(w.root, "signature-probe");
    await writeFile(helper, "#!/bin/sh\ntouch signature-ran\nexit 1\n", { mode: 0o700 });
    await git("config", "gpg.program", helper);
    await git("config", "log.showSignature", "true");
    await git("log", "-1");
    await access(join(w.cwd, "signature-ran"));
    await unlink(join(w.cwd, "signature-ran"));
    await git("config", "core.fsmonitor", "touch fsmonitor-ran");
    await git("config", "diff.external", "touch diff-ran");
    const index = await readFile(join(w.cwd, ".git/index"));
    for (const command of ["git log --oneline -n 1", "git log", "git status -sb && git diff --stat | head -n 2"]) {
      const result = await classify(call("bash", { command }), w.cwd, builtin("bash"), [], [], "common");
      assert.equal(result.review, false, command);
      await exec("bash", ["-c", result.bashCommand!], options);
    }
    assert.deepEqual(await readFile(join(w.cwd, ".git/index")), index);
    for (const marker of ["signature-ran", "fsmonitor-ran", "diff-ran"]) await assert.rejects(access(join(w.cwd, marker)), { code: "ENOENT" });
    await git("config", "filter.test.clean", "touch filter-ran");
    assert.equal((await classify(call("bash", { command: "echo ok; git status -sb | head -n 1" }), w.cwd, builtin("bash"), [], [], "common")).review, true);
    await assert.rejects(access(join(w.cwd, "filter-ran")), { code: "ENOENT" });
  } finally { await w.cleanup(); }
});

test("compound bypass is hardened and audited, and fails closed on audit errors or mutation", async () => {
  const w = await workspace();
  try {
    await writeFile(join(w.cwd, "a.txt"), "a\n");
    let reviews = 0;
    const records: AuditRecord[] = [];
    const config = { ...parseConfig({}), model: "test/model" };
    const event = call("bash", { command: "cat a.txt | head -n 1", timeout: 10 });
    const makeEngine = (audit = async (record: AuditRecord) => { records.push(record); }) => new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [],
      audit, review: async () => { reviews++; return { decision: "deny", risk: "low", authorization: "implicit", reason: "test" }; },
    });
    const result = await makeEngine().handle(event, context(w.cwd).ctx);
    assert.ok(result && "input" in result && result.input?.command !== event.input.command);
    assert.equal(reviews, 0);
    assert.equal(records[0].model, null);
    assert.equal(records[0].bypassRule, "common:cat+common:head");
    assert.ok(!JSON.stringify(records).includes("a.txt"));
    assert.equal((await makeEngine(async () => { throw new Error("disk full"); }).handle(event, context(w.cwd).ctx))?.block, true);
    assert.equal((await makeEngine(async () => { event.input.command = "rm a.txt"; }).handle(event, context(w.cwd).ctx))?.block, true);
    config.bashBypassEnabled = false;
    await makeEngine().handle(call(), context(w.cwd).ctx);
    assert.equal(reviews, 1);
  } finally { await w.cleanup(); }
});

test("invalid configuration cannot reactivate the default common preset", async () => {
  const w = await workspace();
  try {
    const records: AuditRecord[] = [];
    const engine = new ReviewEngine({
      config: () => { throw new Error("invalid configuration"); }, sources: () => [builtin("bash")], protectedRoots: [],
      audit: async record => { records.push(record); },
      review: async () => { throw new Error("no configured reviewer"); },
    });
    assert.equal((await engine.handle(call(), context(w.cwd).ctx))?.block, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].bypassRule, undefined);
    assert.equal(records[0].decision, "error");
  } finally { await w.cleanup(); }
});
