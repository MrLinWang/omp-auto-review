import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classify } from "../src/policy.ts";
import { builtin, call, workspace } from "./helpers.ts";

test("only known native reads and ordinary writes bypass review", async () => {
  const w = await workspace();
  try {
    for (const [name, input] of [
      ["read", { path: "a.ts" }], ["glob", {}], ["grep", { pattern: "TODO" }],
      ["write", { path: "src/new.ts", content: "ok" }],
      ["edit", { path: "a.ts", old_string: "a", new_string: "b" }],
      ["edit", { input: "*** Begin Patch\n[a.ts#abcd]\nPUT >$:\n+ok\n*** End Patch" }],
    ] as const) assert.equal((await classify(call(name, input), w.cwd, builtin(name), [])).review, false, name);
    for (const name of ["bash", "python", "task", "lsp", "delete", "move", "browser", "mcp__foo__read", "unknown"]) {
      assert.equal((await classify(call(name), w.cwd, builtin(name), [])).review, true, name);
    }
    assert.equal((await classify(call("read", { path: "a" }), w.cwd, undefined, [])).review, true);
    assert.equal((await classify(call("read", { path: "a" }), w.cwd,
      { name: "read", sourceInfo: { source: "builtin", path: "/custom/read.ts" } }, [])).review, true);
  } finally { await w.cleanup(); }
});

test("sensitive files, dispatches, ambiguous paths, delete/move patches are reviewed", async () => {
  const w = await workspace();
  try {
    for (const path of ["../outside", "xd://bash", "local://root/a", ".env", ".git/config", "AGENTS.md", ".omp/config.yml", "a.pem", "~/a", "a\0b", "data.zip:entry"]) {
      assert.equal((await classify(call("write", { path, content: "x" }), w.cwd, builtin("write"), [])).review, true, path);
    }
    for (const input of [
      { input: "[a.ts#abcd]\nREM", path: "innocent.ts" },
      { input: "[a.ts#abcd]\nMV ../outside" },
      { path: "a", edits: [{ op: "delete" }] },
      { path: "a", edits: [{ rename: "b", diff: "x" }] },
      { input: "*** Delete File: a" },
      { input: "[a.ts#abcd]\nPUT >$:\n+ok\n[../outside#abcd]\nPUT >$:\n+x", path: "safe.ts" },
      { path: "a", input: "unknown patch" },
      { path: ".env", input: "[safe.ts#abcd]\nPUT >$:\n+ok" },
      { path: "safe.ts", old_string: "x", new_string: "y", input: "[safe.ts#abcd]\nPUT >$:\n+ok" },
    ]) assert.equal((await classify(call("edit", input), w.cwd, builtin("edit"), [])).review, true);
    assert.equal((await classify(call("write", { path: "src/a", content: "x" }), w.cwd, builtin("write"), [w.cwd])).review, true);
  } finally { await w.cleanup(); }
});

test("realpath checks include symlink ancestors and dangling links", async () => {
  const w = await workspace();
  try {
    await mkdir(join(w.root, "outside"));
    await symlink(join(w.root, "outside"), join(w.cwd, "escape"));
    await symlink(join(w.root, "missing"), join(w.cwd, "dangling"));
    await writeFile(join(w.cwd, ".env"), "SECRET");
    await symlink(join(w.cwd, ".env"), join(w.cwd, "innocent.txt"));
    for (const path of ["escape/new/file.ts", "dangling", "innocent.txt"]) {
      assert.equal((await classify(call("write", { path, content: "x" }), w.cwd, builtin("write"), [])).review, true, path);
    }
  } finally { await w.cleanup(); }
});
