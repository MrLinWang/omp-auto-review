import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerReviewCommand } from "../src/commands.ts";
import { ConfigStore, parseConfig } from "../src/config.ts";
import { ReviewEngine } from "../src/engine.ts";
import { builtin, call, context, workspace } from "./helpers.ts";

test("bash commands persist only the switch, reload immediately and cancel pending reviews", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    let config = parseConfig({ model: "test/model", bashReadonlyPreset: "common", bashAllowCommands: ["pwd -P"] });
    await store.save(config);
    let started!: () => void;
    const reviewing = new Promise<void>(resolve => { started = resolve; });
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], audit: async () => {},
      review: async () => { started(); return new Promise(() => {}); },
    });
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    let reloads = 0;
    registerReviewCommand({ registerCommand: (name, spec) => { assert.equal(name, "auto-review"); handler = spec.handler; } }, {
      config: () => config, configError: () => false, status: () => "ready", cancel: () => engine.cancel(), store,
      load: async () => { engine.cancel(); config = await store.load(); reloads++; },
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: string[] = [];
    ctx.ui.notify = message => { messages.push(message); };
    const pending = engine.handle(call("bash", { command: "npm test" }), ctx);
    await reviewing;
    await handler("bash off", ctx);
    assert.equal((await pending)?.block, true);
    assert.equal(config.bashBypassEnabled, false);
    assert.equal((await store.load()).bashBypassEnabled, false);
    assert.equal(config.bashReadonlyPreset, "common");
    assert.deepEqual(config.bashAllowCommands, ["pwd -P"]);
    assert.equal(reloads, 1);
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /总开关：关闭/);
    assert.match(messages.at(-1)!, /只读预设：common/);
    assert.match(messages.at(-1)!, /附加免审规则：pwd -P/);
    await handler("bash on", ctx);
    assert.equal(config.bashBypassEnabled, true);
    assert.equal(reloads, 2);
    assert.ok((await engine.handle(call(), ctx))?.input);
    const saved = await readFile(store.path, "utf8");
    await handler("bash maybe", ctx);
    assert.match(messages.at(-1)!, /用法/);
    assert.equal(await readFile(store.path, "utf8"), saved);
  } finally { await w.cleanup(); }
});

test("save failures and invalid configuration do not change the active switch; empty extras are displayed accurately", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    // A directory at the config filename reliably makes atomic replacement fail.
    await mkdir(store.path, { recursive: true });
    const config = parseConfig({});
    let invalid = false, reloads = 0;
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => invalid, status: () => "ready", cancel: () => {}, store,
      load: async () => { reloads++; },
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: string[] = [];
    ctx.ui.notify = message => { messages.push(message); };
    await handler("bash off", ctx);
    assert.equal(config.bashBypassEnabled, true);
    assert.equal(reloads, 0);
    assert.match(messages.at(-1)!, /未切换/);
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /总开关：开启/);
    assert.match(messages.at(-1)!, /无附加规则/);
    invalid = true;
    await handler("bash off", ctx);
    assert.match(messages.at(-1)!, /配置无效/);
    assert.equal(reloads, 0);
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /总开关：关闭/);
  } finally { await w.cleanup(); }
});
