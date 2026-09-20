import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerReviewCommand } from "../src/commands.ts";
import { ConfigStore, jevDefaults, parseConfig } from "../src/config.ts";
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


test("jev commands persist the prefilter switch, keep the block and never display the key", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    let config = parseConfig({ model: "test/model", jev: { apiKey: "ts-secret-value", confidenceThreshold: 0.9, apiKeyEnv: "OMP_REVIEW_CMD_KEY" } });
    await store.save(config);
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    let invalid = false;
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => invalid, status: () => "ready", cancel: () => {}, store,
      load: async () => { config = await store.load(); },
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: string[] = [];
    ctx.ui.notify = message => { messages.push(message); };
    delete process.env.OMP_REVIEW_CMD_KEY;

    await handler("status", ctx);
    assert.match(messages.at(-1)!, /前置审查（jev）：开启；模型：jev-latest；可信阈值：0\.9/);
    assert.match(messages.at(-1)!, /前置审查密钥：配置文件/);
    assert.match(messages.at(-1)!, /前置审查端点：https:\/\/api\.typesafe\.ai\/v1\/systemone/);
    assert.match(messages.at(-1)!, /最坏占用审核总超时 10500ms/);
    assert.ok(!messages.at(-1)!.includes("ts-secret-value"));

    process.env.OMP_REVIEW_CMD_KEY = "from-env";
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /前置审查密钥：环境变量 OMP_REVIEW_CMD_KEY/);
    assert.ok(!messages.at(-1)!.includes("from-env"));

    // Turning it off keeps every other jev field, exactly like the Bash switch.
    await handler("jev off", ctx);
    assert.equal(config.jev!.enabled, false);
    assert.equal(config.jev!.confidenceThreshold, 0.9);
    assert.equal(config.jev!.apiKey, "ts-secret-value");
    assert.equal((await store.load()).jev!.enabled, false);
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /前置审查（jev）：关闭/);
    await handler("jev on", ctx);
    assert.equal(config.jev!.enabled, true);
    assert.ok(!messages.at(-1)!.includes("ts-secret-value"));

    invalid = true;
    const saved = await readFile(store.path, "utf8");
    await handler("jev off", ctx);
    assert.match(messages.at(-1)!, /配置无效/);
    assert.equal(await readFile(store.path, "utf8"), saved);
    invalid = false;
    await handler("jev maybe", ctx);
    assert.match(messages.at(-1)!, /用法/);
  } finally { delete process.env.OMP_REVIEW_CMD_KEY; await w.cleanup(); }
});

test("jev on writes the documented defaults when no block exists and warns about a missing key", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    let config = parseConfig({ model: "test/model" });
    await store.save(config);
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => false, status: () => "ready", cancel: () => {}, store,
      load: async () => { config = await store.load(); },
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: [string, string][] = [];
    ctx.ui.notify = (message, level) => { messages.push([message, String(level)]); };
    await handler("status", ctx);
    assert.match(messages.at(-1)![0], /前置审查（jev）：未配置/);
    await handler("jev on", ctx);
    assert.deepEqual(config.jev, { ...jevDefaults });
    assert.deepEqual((await store.load()).jev, { ...jevDefaults });
    // No key anywhere means the prefilter would be skipped; say so instead of looking healthy.
    assert.match(messages.at(-1)![0], /未找到 API 密钥/);
    assert.equal(messages.at(-1)![1], "warning");
  } finally { await w.cleanup(); }
});
