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
      jevModels: () => [],
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
      jevModels: () => [],
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


test("jev commands persist the prefilter switch, keep the policy block and show host candidates", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    // Non-default policy values make the preservation check meaningful.
    let config = parseConfig({ model: "test/model", jev: { confidenceThreshold: 0.9, retryCount: 2 } });
    await store.save(config);
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    let invalid = false;
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => invalid, status: () => "ready", cancel: () => {}, store,
      load: async () => { config = await store.load(); },
      jevModels: () => ["typesafe/jev-latest", "typesafe/jev-1.13.0"],
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: [string, string][] = [];
    ctx.ui.notify = (message, level) => { messages.push([message, String(level)]); };

    await handler("status", ctx);
    assert.equal(messages.at(-1)![1], "info");
    assert.ok(messages.at(-1)![0].includes("typesafe/jev-latest"));
    assert.ok(messages.at(-1)![0].includes("typesafe/jev-1.13.0"));

    // Turning it off keeps every other jev field, exactly like the Bash switch.
    await handler("jev off", ctx);
    assert.equal(config.jev!.enabled, false);
    assert.equal(config.jev!.confidenceThreshold, 0.9);
    assert.equal(config.jev!.retryCount, 2);
    const persisted = (await store.load()).jev!;
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.confidenceThreshold, 0.9);
    assert.equal(persisted.retryCount, 2);
    // A disabled prefilter never warns about missing candidates.
    await handler("status", ctx);
    assert.equal(messages.at(-1)![1], "info");
    await handler("jev on", ctx);
    assert.equal(config.jev!.enabled, true);
    assert.equal(messages.at(-1)![1], "info");

    invalid = true;
    const saved = await readFile(store.path, "utf8");
    await handler("jev off", ctx);
    assert.equal(messages.at(-1)![1], "error");
    assert.equal(await readFile(store.path, "utf8"), saved);
    invalid = false;
    await handler("jev maybe", ctx);
    assert.equal(await readFile(store.path, "utf8"), saved);
  } finally { await w.cleanup(); }
});

test("jev on writes a policy block when none exists and warns without host judge candidates", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    let config = parseConfig({ model: "test/model" });
    await store.save(config);
    let candidates: readonly string[] = [];
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => false, status: () => "ready", cancel: () => {}, store,
      load: async () => { config = await store.load(); },
      jevModels: () => candidates,
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: [string, string][] = [];
    ctx.ui.notify = (message, level) => { messages.push([message, String(level)]); };
    assert.equal(config.jev, undefined);
    await handler("jev on", ctx);
    // The switch created and persisted an enabled block without touching the LLM model.
    assert.equal(config.jev!.enabled, true);
    assert.equal(config.model, "test/model");
    assert.deepEqual((await store.load()).jev, config.jev);
    // No host judge candidate means the prefilter would be skipped; warn instead of looking healthy.
    assert.equal(messages.at(-1)![1], "warning");
    candidates = ["typesafe/jev-latest"];
    await handler("status", ctx);
    assert.equal(messages.at(-1)![1], "info");
    assert.ok(messages.at(-1)![0].includes("typesafe/jev-latest"));
    await handler("jev on", ctx);
    assert.equal(messages.at(-1)![1], "info");
    assert.equal((await store.load()).jev!.enabled, true);
  } finally { await w.cleanup(); }
});
