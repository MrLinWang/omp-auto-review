import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { ConfigStore, parseConfig } from "../src/config.ts";
import { registerReviewCommand } from "../src/commands.ts";
import { ReviewEngine } from "../src/engine.ts";
import { builtin, call, context, workspace } from "./helpers.ts";

test("enabled defaults to true and accepts only booleans", () => {
  assert.equal(parseConfig({}).enabled, true);
  assert.equal(parseConfig({ enabled: false }).enabled, false);
  for (const enabled of [null, 0, 1, "false", [], {}]) {
    assert.throws(() => parseConfig({ enabled }), /enabled/);
  }
  assert.throws(() => parseConfig({ enabled: false, model: "invalid" }));
});

test("disabled review leaves all calls untouched without policy, model, UI or log work", async () => {
  const unexpected = () => { assert.fail("disabled review must not invoke dependencies"); };
  const engine = new ReviewEngine({
    config: () => parseConfig({ enabled: false, reviewLogPath: "reviews.jsonl" }),
    sources: unexpected, history: unexpected, protectedRoots: [],
    review: unexpected, audit: unexpected, reviewLog: unexpected, onResult: unexpected,
  });
  const ctx = context("/tmp", unexpected).ctx;
  for (const event of [call(), call("bash", { command: "npm test" }), call("mcp_unknown"), call("write", { path: "/tmp/.env", content: "x" })]) {
    const original = structuredClone(event);
    assert.equal(await engine.handle(event, ctx), undefined);
    assert.deepEqual(event, original);
  }
});

test("off cancels pending reviews, persists all settings and on resumes review", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    let config = parseConfig({ model: "test/model", fallbackModels: ["test/backup"], bashAllowCommands: ["pwd -P"] });
    const original = structuredClone(config);
    await store.save(config);
    let started!: () => void;
    const reviewing = new Promise<void>(resolve => { started = resolve; });
    let reviews = 0;
    const engine = new ReviewEngine({
      config: () => config, sources: () => [builtin("bash")], protectedRoots: [], audit: async () => {},
      review: async () => {
        reviews++;
        if (reviews === 1) { started(); return new Promise(() => {}); }
        return { decision: "deny", risk: "high", authorization: "none", reason: "denied" };
      },
    });
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => false, status: () => config.enabled ? "已启用" : "已关闭",
      cancel: () => engine.cancel(), store,
      load: async () => { engine.cancel(); config = await store.load(); },
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: string[] = [];
    ctx.ui.notify = message => { messages.push(message); };
    const event = call("bash", { command: "npm test" });
    const pending = engine.handle(event, ctx);
    await reviewing;
    await handler("off", ctx);
    assert.equal((await pending)?.block, true);
    assert.deepEqual(await store.load(), { ...original, enabled: false });
    assert.equal(await engine.handle(event, ctx), undefined);
    assert.equal(reviews, 1);
    await handler("status", ctx);
    assert.match(messages.at(-1)!, /已关闭/);
    const saved = await readFile(store.path, "utf8");
    await handler("off extra", ctx);
    assert.match(messages.at(-1)!, /用法/);
    assert.equal(await readFile(store.path, "utf8"), saved);
    await handler("on", ctx);
    assert.deepEqual(await store.load(), original);
    assert.equal((await engine.handle(event, ctx))?.block, true);
    assert.equal(reviews, 2);
  } finally { await w.cleanup(); }
});

test("failed saves and malformed config cannot switch review off", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    await mkdir(store.path, { recursive: true });
    const config = parseConfig({});
    let invalid = false;
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    registerReviewCommand({ registerCommand: (_name, spec) => { handler = spec.handler; } }, {
      config: () => config, configError: () => invalid, status: () => "ready", store,
      cancel: () => assert.fail("must not cancel"), load: async () => assert.fail("must not reload"),
    });
    const ctx = context(w.cwd).ctx as ExtensionCommandContext;
    const messages: string[] = [];
    ctx.ui.notify = message => { messages.push(message); };
    await handler("off", ctx);
    assert.match(messages.at(-1)!, /未切换/);
    assert.equal(config.enabled, true);
    invalid = true;
    await handler("off", ctx);
    assert.match(messages.at(-1)!, /配置无效/);
    assert.equal(config.enabled, true);
  } finally { await w.cleanup(); }
});
