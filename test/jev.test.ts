import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ConfigStore, defaults, jevApiKey, jevBudgetMs, jevDefaults, parseConfig } from "../src/config.ts";
import { buildJevBody, gateJevAnswer, JEV_QUESTION_ID, jevVerdict, parseJevResponse, reviewWithJev } from "../src/jev.ts";
import { buildReviewPayload } from "../src/reviewer.ts";
import { formatAttempts, ReviewAttemptError, type ReviewAttempt } from "../src/attempt.ts";
import { call, userHistory, workspace } from "./helpers.ts";

const jev = (extra: Record<string, unknown> = {}) => ({ jev: { ...extra } });

test("the jev block is optional and defaults to the documented TypeSafe endpoint", () => {
  assert.equal(parseConfig({}).jev, undefined);
  assert.equal(parseConfig({ model: "p/m" }).jev, undefined);
  const parsed = parseConfig(jev())!.jev!;
  assert.deepEqual(parsed, { ...jevDefaults });
  assert.equal(parsed.baseUrl, "https://api.typesafe.ai/v1/systemone");
  assert.equal(parsed.model, "jev-latest");
  assert.equal(parsed.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(parsed.confidenceThreshold, 0.85);
  assert.equal(parsed.apiKey, undefined);
});

test("jev.baseUrl requires https, rejects embedded credentials and allows loopback http", () => {
  for (const baseUrl of [
    "http://api.typesafe.ai/v1/systemone",
    "http://example.com/v1/systemone",
    "ftp://api.typesafe.ai/v1/systemone",
    "/v1/systemone",
    "api.typesafe.ai",
    "https://user:pass@api.typesafe.ai/v1/systemone",
    "https://api.typesafe.ai/v1/systemone?key=leak",
    "https://api.typesafe.ai/v1/systemone#frag",
    42,
  ]) assert.throws(() => parseConfig(jev({ baseUrl })), /baseUrl/);
  // Loopback http exists so tests and local proxies can stand in for the real endpoint.
  for (const baseUrl of ["http://127.0.0.1:8123/v1/systemone", "http://localhost:8123/v1/systemone", "http://[::1]:8123/v1/systemone"]) {
    assert.equal(parseConfig(jev({ baseUrl })).jev!.baseUrl, baseUrl);
  }
  assert.equal(parseConfig(jev({ baseUrl: "https://proxy.internal/v1/systemone" })).jev!.baseUrl, "https://proxy.internal/v1/systemone");
});

test("jev.model is a bare jev name, never a provider/model spec", () => {
  for (const model of ["provider/jev-latest", "", "-jev", "jev latest", "jev/latest", 1, null]) {
    assert.throws(() => parseConfig(jev({ model })), /jev\.model/);
  }
  assert.equal(parseConfig(jev({ model: "jev-1.13.0" })).jev!.model, "jev-1.13.0");
  assert.equal(parseConfig(jev({ model: "jev-preview" })).jev!.model, "jev-preview");
});

test("the confidence threshold must sit above TypeSafe's 0.5 uncertainty floor", () => {
  for (const confidenceThreshold of [0.5, 0.4, 0, -1, 1.1, 2, Number.NaN, Number.POSITIVE_INFINITY, "0.9", null]) {
    assert.throws(() => parseConfig(jev({ confidenceThreshold })), /confidenceThreshold/);
  }
  assert.equal(parseConfig(jev({ confidenceThreshold: 0.5001 })).jev!.confidenceThreshold, 0.5001);
  assert.equal(parseConfig(jev({ confidenceThreshold: 1 })).jev!.confidenceThreshold, 1);
});

test("jev key fields are validated without echoing the key, and unknown fields are rejected", () => {
  for (const apiKeyEnv of ["1KEY", "my key", "MY-KEY", "", 5]) assert.throws(() => parseConfig(jev({ apiKeyEnv })), /apiKeyEnv/);
  assert.equal(parseConfig(jev({ apiKeyEnv: "MY_TYPESAFE_KEY" })).jev!.apiKeyEnv, "MY_TYPESAFE_KEY");
  for (const apiKey of ["", " ", "has space", "tab\there", 7]) {
    // The rejection must name the field only; the attempted value must never appear.
    const error = (() => { try { parseConfig(jev({ apiKey })); return undefined; } catch (e) { return e as Error; } })();
    assert.ok(error, `expected rejection for ${JSON.stringify(apiKey)}`);
    assert.match(error!.message, /apiKey/);
    if (typeof apiKey === "string" && apiKey.trim()) assert.ok(!error!.message.includes(apiKey));
  }
  assert.equal(parseConfig(jev({ apiKey: "ts-secret-value" })).jev!.apiKey, "ts-secret-value");
  assert.throws(() => parseConfig(jev({ nope: true })), /未知 jev 配置字段/);
  assert.throws(() => parseConfig({ jev: [] }), /jev 必须是 JSON 对象/);
  assert.throws(() => parseConfig({ jev: "on" }), /jev 必须是 JSON 对象/);
});

test("jev timeouts and retries are bounded and must fit inside the review budget", () => {
  for (const timeoutMs of [0, -1, 30_001, 1.5, "5000"]) assert.throws(() => parseConfig(jev({ timeoutMs })), /jev\.timeoutMs/);
  for (const retryCount of [-1, 4, 1.5]) assert.throws(() => parseConfig(jev({ retryCount })), /jev\.retryCount/);
  for (const retryDelayMs of [-1, 10_001, 1.5]) assert.throws(() => parseConfig(jev({ retryDelayMs })), /jev\.retryDelayMs/);
  // Worst case = every attempt timing out plus the waits between them.
  assert.equal(jevBudgetMs(parseConfig(jev()).jev), 5_000 * 2 + 500);
  assert.equal(jevBudgetMs(parseConfig(jev({ retryCount: 0 })).jev), 5_000);
  assert.equal(jevBudgetMs(parseConfig(jev({ enabled: false })).jev), 0);
  assert.equal(jevBudgetMs(undefined), 0);
  // The prefilter shares reviewTimeoutMs rather than extending the 110000ms total.
  assert.ok(jevBudgetMs(parseConfig(jev()).jev) < defaults.reviewTimeoutMs);
  assert.equal(parseConfig({ ...jev(), reviewTimeoutMs: 20_000, confirmationTimeoutMs: 90_000 }).reviewTimeoutMs, 20_000);
  assert.throws(() => parseConfig({ ...jev({ timeoutMs: 10_000, retryCount: 1 }), reviewTimeoutMs: 20_000 }), /必须小于 reviewTimeoutMs/);
  assert.throws(() => parseConfig({ ...jev({ timeoutMs: 20_000, retryCount: 0 }), reviewTimeoutMs: 20_000 }), /必须小于 reviewTimeoutMs/);
  assert.equal(parseConfig({ ...jev({ timeoutMs: 20_000, retryCount: 0 }), reviewTimeoutMs: 20_001, confirmationTimeoutMs: 89_000 }).reviewTimeoutMs, 20_001);
  // A disabled block costs nothing, so it never conflicts with the review budget.
  assert.ok(parseConfig({ ...jev({ enabled: false, timeoutMs: 30_000 }), reviewTimeoutMs: 20_000 }).jev);
});

test("jevApiKey prefers the environment variable and never reports a key it does not have", () => {
  const config = parseConfig(jev({ apiKeyEnv: "OMP_REVIEW_TEST_KEY", apiKey: "from-config" })).jev!;
  delete process.env.OMP_REVIEW_TEST_KEY;
  try {
    assert.deepEqual(jevApiKey(config), { key: "from-config", source: "config" });
    process.env.OMP_REVIEW_TEST_KEY = "  from-env  ";
    assert.deepEqual(jevApiKey(config), { key: "from-env", source: "env" });
    // An empty or whitespace-only variable must not shadow the configured key.
    process.env.OMP_REVIEW_TEST_KEY = "   ";
    assert.deepEqual(jevApiKey(config), { key: "from-config", source: "config" });
    assert.deepEqual(jevApiKey({ ...config, apiKey: undefined }), { source: "none" });
  } finally { delete process.env.OMP_REVIEW_TEST_KEY; }
});

test("the jev block survives a save/load round trip untouched", async () => {
  const w = await workspace();
  try {
    const store = new ConfigStore(join(w.root, "agent"));
    const config = parseConfig({
      model: "test/model",
      jev: { baseUrl: "http://127.0.0.1:8123/v1/systemone", model: "jev-1.13.0", confidenceThreshold: 0.92, apiKey: "ts-secret-value", retryCount: 0 },
    });
    await store.save(config);
    const loaded = await store.load();
    assert.deepEqual(loaded.jev, config.jev);
    // Toggling an unrelated switch the way the commands do must not drop the block.
    await store.save({ ...loaded, bashBypassEnabled: false });
    assert.deepEqual((await store.load()).jev, config.jev);
  } finally { await w.cleanup(); }
});


test("the request body matches the documented { state, model, questions } shape", () => {
  const config = parseConfig({ jev: { model: "jev-1.13.0" } });
  const payload = buildReviewPayload({ operation: call("bash", { command: "npm test" }), cwd: "/work", trigger: "bash", history: userHistory }, config);
  const body = buildJevBody(payload, config.jev!);
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(body.questions), [JEV_QUESTION_ID]);
  const question = body.questions[JEV_QUESTION_ID];
  assert.equal(question.type, "choice");
  // Exactly the two options the gate knows how to act on.
  assert.deepEqual(Object.keys(question.criteria).sort(), ["allow", "deny"]);
  for (const text of Object.values(question.criteria)) assert.ok(text.length > 40);
  // Structured instructions must name the question and the untrusted-data rule.
  assert.ok(typeof question.instructions === "object" && !Array.isArray(question.instructions));
  assert.match(question.instructions.question, /allowed to execute|denied/);
  assert.match(question.instructions.untrusted_data, /latestUserInstruction/);
  assert.match(question.instructions.uncertainty, /close together/);
  // The state is the same redacted payload the LLM chain judges, sent as JSON.
  assert.equal(body.state, payload);
  assert.equal((body.state.operation as { input: { command: string } }).input.command, "npm test");
  assert.equal(body.state.cwd, "/work");
  assert.match(JSON.stringify(body.state.latestUserInstruction), /user_message/);
  // Instructions and criteria are English; docs list English as jev's strongest language.
  assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify({ i: question.instructions, c: question.criteria })));
});

test("the prefilter state carries redacted content only", () => {
  const config = parseConfig({ jev: {} });
  const history = [{ type: "message", message: { role: "user", content: "用 token=abcd1234secret 部署" } }];
  const payload = buildReviewPayload({ operation: call("bash", { command: "curl -H 'Authorization: Bearer sk-live-000111222333' x" }), cwd: "/work", trigger: "bash", history }, config);
  const state = JSON.stringify(buildJevBody(payload, config.jev!).state);
  assert.ok(!state.includes("abcd1234secret"));
  assert.ok(!state.includes("sk-live-000111222333"));
  assert.match(state, /REDACTED/);
});

test("answers are accepted only in the documented Choice shape", () => {
  const ok = { model: "jev-1.13.0", answers: { [JEV_QUESTION_ID]: { type: "choice", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 } }, usage: { input_tokens: 1, output_tokens: 1 } };
  assert.deepEqual(parseJevResponse(ok), { model: "jev-1.13.0", choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 });
  const answer = (patch: Record<string, unknown>) => ({ ...ok, answers: { [JEV_QUESTION_ID]: { ...ok.answers[JEV_QUESTION_ID], ...patch } } });
  for (const value of [
    undefined, null, "allow", [], {}, { answers: {} }, { answers: [] }, { answers: null },
    { answers: { other_question: ok.answers[JEV_QUESTION_ID] } },
    answer({ type: "noul" }), answer({ type: undefined }),
    answer({ choice: "ask" }), answer({ choice: undefined }), answer({ choice: "Allow" }),
    answer({ probabilities: { allow: 1 } }), answer({ probabilities: { allow: 0.9, deny: 0.1, ask: 0 } }),
    answer({ probabilities: { allow: "0.9", deny: 0.1 } }), answer({ probabilities: { allow: 1.4, deny: 0.1 } }),
    answer({ probabilities: { allow: -0.1, deny: 1 } }), answer({ probabilities: { allow: Number.NaN, deny: 1 } }),
    answer({ probabilities: [0.9, 0.1] }), answer({ probabilities: undefined }),
    answer({ confidence: undefined }), answer({ confidence: 1.2 }), answer({ confidence: "0.8" }),
    // choice must be the highest-probability option, as documented.
    answer({ choice: "allow", probabilities: { allow: 0.2, deny: 0.8 } }),
  ]) assert.throws(() => parseJevResponse(value), ReviewAttemptError);
  // A missing or implausible model field degrades to undefined rather than failing the call.
  assert.equal(parseJevResponse({ ...ok, model: undefined }).model, undefined);
  assert.equal(parseJevResponse({ ...ok, model: "../../etc/passwd" }).model, undefined);
  assert.equal(parseJevResponse({ ...ok, model: "jev\u001b[31m" }).model, undefined);
  assert.equal(parseJevResponse(answer({ choice: "deny", probabilities: { allow: 0.1, deny: 0.9 } })).choice, "deny");
});

test("the gate thresholds the winning option's probability and honours the 0.5 confidence floor", () => {
  const gate = (allow: number, deny: number, confidence: number, threshold = 0.85) =>
    gateJevAnswer({ choice: allow >= deny ? "allow" : "deny", probabilities: { allow, deny }, confidence }, threshold);
  const trusted = gate(0.93, 0.07, 0.88);
  assert.deepEqual(trusted, { decision: "allow", probability: 0.93, confidence: 0.88, threshold: 0.85, trusted: true });
  assert.equal(gate(0.05, 0.95, 0.9).decision, "deny");
  assert.equal(gate(0.05, 0.95, 0.9).probability, 0.95);
  assert.equal(gate(0.05, 0.95, 0.9).trusted, true);
  // Exactly at the threshold is trusted; a hair below is not.
  assert.equal(gate(0.85, 0.15, 0.9).trusted, true);
  assert.equal(gate(0.8499, 0.1501, 0.99).trusted, false);
  // A flat distribution is the documented way for jev to say "I cannot tell".
  assert.equal(gate(0.52, 0.48, 0.1).trusted, false);
  // High winning probability with sub-floor confidence still escalates.
  assert.equal(gate(0.99, 0.01, 0.49).trusted, false);
  assert.equal(gate(0.99, 0.01, 0.5).trusted, true);
  assert.equal(gate(0.9, 0.1, 0.9, 1).trusted, false);
  assert.equal(gate(1, 0, 1, 1).trusted, true);
});

test("verdicts are composed locally, only for trusted gates, and carry no model text", () => {
  const allow = jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.93, deny: 0.07 }, confidence: 0.88 }, 0.85), "jev-1.13.0");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.source, "prefilter");
  assert.equal(allow.recommendation, undefined);
  // jev grades no risk and no authorization, so neither is claimed.
  assert.equal(allow.risk, undefined);
  assert.equal(allow.authorization, undefined);
  assert.equal(allow.reason, "前置审查（jev-1.13.0）判定可放行：胜出概率 0.93 ≥ 阈值 0.85（confidence 0.88）");
  const deny = jevVerdict(gateJevAnswer({ choice: "deny", probabilities: { allow: 0.02, deny: 0.98 }, confidence: 0.97 }, 0.9), "jev-1.13.0");
  assert.equal(deny.decision, "deny");
  assert.match(deny.reason, /判定应拒绝：胜出概率 0\.98 ≥ 阈值 0\.9（confidence 0\.97）/);
  // A fine-grained threshold keeps its precision instead of rounding to two places.
  assert.match(jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.6, deny: 0.4 }, confidence: 0.7 }, 0.5001), "jev-latest").reason, /阈值 0\.5001/);
  // Terminal control sequences in a model name cannot reach the confirmation dialog.
  assert.ok(!jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 1, deny: 0 }, confidence: 1 }, 0.85), "jev\u001b[31m").reason.includes("\u001b"));
  assert.throws(() => jevVerdict(gateJevAnswer({ choice: "allow", probabilities: { allow: 0.6, deny: 0.4 }, confidence: 0.6 }, 0.85), "jev-latest"), /置信度不足/);
});


interface MockReply { status?: number; body?: string; delayMs?: number; location?: string }
interface MockRequest { method: string; url: string; headers: Record<string, string | undefined>; body: string }

/** A real HTTP server so headers, status handling, redirects and body limits are exercised for real. */
async function jevServer(replies: (request: MockRequest, index: number) => MockReply) {
  const requests: MockRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const request: MockRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers as Record<string, string | undefined>, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(request);
      const reply = replies(request, requests.length - 1);
      const send = () => {
        if (reply.location) { res.writeHead(302, { location: reply.location }); res.end(); return; }
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(reply.body ?? JSON.stringify(answerBody("allow", 0.93, 0.07, 0.88)));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const answerBody = (choice: "allow" | "deny", allow: number, deny: number, confidence: number, model = "jev-1.13.0") =>
  ({ model, answers: { [JEV_QUESTION_ID]: { type: "choice", choice, probabilities: { allow, deny }, confidence } }, usage: { input_tokens: 10, output_tokens: 2 } });

const payloadFor = (command = "npm test") => buildReviewPayload(
  { operation: call("bash", { command }), cwd: "/work", trigger: "bash", history: userHistory },
  parseConfig({}),
);

const jevFor = (baseUrl: string, extra: Partial<typeof jevDefaults> = {}) =>
  ({ ...jevDefaults, baseUrl, apiKey: "ts-secret-value", timeoutMs: 1_000, retryCount: 1, retryDelayMs: 5, ...extra });

test("a real call sends the documented request and returns a trusted gate", async () => {
  const server = await jevServer(() => ({}));
  try {
    const attempts: ReviewAttempt[] = [];
    const outcome = await reviewWithJev(payloadFor(), jevFor(server.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a }));
    assert.equal(server.requests.length, 1);
    const request = server.requests[0];
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/systemone");
    assert.equal(request.headers.authorization, "Bearer ts-secret-value");
    assert.equal(request.headers["content-type"], "application/json");
    const sent = JSON.parse(request.body);
    assert.deepEqual(Object.keys(sent).sort(), ["model", "questions", "state"]);
    assert.equal(sent.model, "jev-latest");
    assert.equal(sent.questions[JEV_QUESTION_ID].type, "choice");
    assert.equal(sent.state.operation.input.command, "npm test");
    // The response's versioned model ID is what gets reported back, not the alias.
    assert.equal(outcome!.model, "jev-1.13.0");
    assert.deepEqual(outcome!.gate, { decision: "allow", probability: 0.93, confidence: 0.88, threshold: 0.85, trusted: true });
    assert.deepEqual(attempts.map(a => [a.model, a.status]), [["jev:jev-latest", "running"], ["jev:jev-latest", "success"]]);
  } finally { await server.close(); }
});

test("an answer below the threshold is returned untrusted rather than as a failure", async () => {
  const server = await jevServer(() => ({ body: JSON.stringify(answerBody("deny", 0.41, 0.59, 0.33)) }));
  try {
    const attempts: ReviewAttempt[] = [];
    const outcome = await reviewWithJev(payloadFor("rm -rf /"), jevFor(server.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a }));
    assert.equal(outcome!.gate.trusted, false);
    assert.equal(outcome!.gate.decision, "deny");
    // Low confidence is a valid answer, so it must not be retried or logged as an error.
    assert.equal(server.requests.length, 1);
    assert.deepEqual(attempts.map(a => a.status), ["running", "success"]);
  } finally { await server.close(); }
});

test("401 and 422 are permanent: one attempt, no retry, and a silent degradation", async () => {
  for (const [status, expected] of [[401, "auth_error"], [403, "auth_error"], [422, "invalid_response"]] as const) {
    const server = await jevServer(() => ({ status, body: JSON.stringify({ error: "key ts-secret-value rejected for command rm -rf /" }) }));
    try {
      const attempts: ReviewAttempt[] = [];
      const outcome = await reviewWithJev(payloadFor(), jevFor(server.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a }));
      assert.equal(outcome, undefined, `status ${status} must degrade`);
      assert.equal(server.requests.length, 1, `status ${status} must not retry`);
      assert.equal(attempts.at(-1)!.status, expected);
      // Neither the key nor the endpoint's error text may surface in diagnostics.
      const diagnostics = formatAttempts(attempts);
      assert.ok(!diagnostics.includes("ts-secret-value"));
      assert.ok(!diagnostics.includes("rm -rf"));
    } finally { await server.close(); }
  }
});

test("429 and 529 are retried with backoff and a later success still wins", async () => {
  const server = await jevServer((_request, index) => (index === 0 ? { status: 429, body: "{}" } : {}));
  try {
    const attempts: ReviewAttempt[] = [];
    const outcome = await reviewWithJev(payloadFor(), jevFor(server.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a }));
    assert.equal(outcome!.gate.trusted, true);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(attempts.map(a => [a.attempt, a.status]), [[1, "running"], [1, "rate_limit"], [2, "running"], [2, "success"]]);
  } finally { await server.close(); }

  const overloaded = await jevServer(() => ({ status: 529, body: "{}" }));
  try {
    const attempts: ReviewAttempt[] = [];
    assert.equal(await reviewWithJev(payloadFor(), jevFor(overloaded.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
    // retryCount 1 means two attempts in total, then degradation.
    assert.equal(overloaded.requests.length, 2);
    assert.deepEqual(attempts.filter(a => a.status !== "running").map(a => a.status), ["rate_limit", "rate_limit"]);
  } finally { await overloaded.close(); }
});

test("malformed, oversized and non-JSON responses degrade without retrying", async () => {
  const cases: [string, string][] = [
    ["not json at all", "invalid_response"],
    [JSON.stringify({ answers: { other: { type: "choice" } } }), "invalid_response"],
    [JSON.stringify(answerBody("allow", 0.4, 0.6, 0.9)), "invalid_response"],
    [JSON.stringify({ model: "jev-1.13.0", answers: { [JEV_QUESTION_ID]: { type: "noul", noul: 0.9 } } }), "invalid_response"],
    [`{"padding":"${"x".repeat(70_000)}"}`, "output_limit"],
  ];
  for (const [body, expected] of cases) {
    const server = await jevServer(() => ({ body }));
    try {
      const attempts: ReviewAttempt[] = [];
      assert.equal(await reviewWithJev(payloadFor(), jevFor(server.baseUrl), 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
      assert.equal(attempts.at(-1)!.status, expected, `body ${body.slice(0, 40)}`);
      assert.equal(server.requests.length, 1);
    } finally { await server.close(); }
  }
});

test("a slow endpoint is abandoned at the per-attempt timeout", async () => {
  const server = await jevServer(() => ({ delayMs: 2_000 }));
  try {
    const attempts: ReviewAttempt[] = [];
    const started = Date.now();
    assert.equal(await reviewWithJev(payloadFor(), jevFor(server.baseUrl, { timeoutMs: 60, retryCount: 0 }), 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
    assert.ok(Date.now() - started < 1_500, "must not wait for the slow response");
    assert.equal(attempts.at(-1)!.status, "timeout");
  } finally { await server.close(); }
});

test("redirects are refused so the key never reaches another host", async () => {
  const elsewhere = await jevServer(() => ({}));
  const server = await jevServer(() => ({ location: elsewhere.baseUrl }));
  try {
    const attempts: ReviewAttempt[] = [];
    assert.equal(await reviewWithJev(payloadFor(), jevFor(server.baseUrl, { retryCount: 0 }), 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
    assert.equal(server.requests.length, 1);
    assert.equal(elsewhere.requests.length, 0, "the redirect target must never be contacted");
    assert.equal(attempts.at(-1)!.status, "call_error");
  } finally { await server.close(); await elsewhere.close(); }
});

test("cancellation propagates instead of degrading to the LLM chain", async () => {
  const server = await jevServer(() => ({ delayMs: 2_000 }));
  try {
    const controller = new AbortController();
    const pending = reviewWithJev(payloadFor(), jevFor(server.baseUrl), 10_000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, /取消/);
  } finally { await server.close(); }
});

test("a missing key skips the prefilter entirely; the environment variable wins when both exist", async () => {
  const server = await jevServer(() => ({}));
  try {
    const attempts: ReviewAttempt[] = [];
    const keyless = { ...jevDefaults, baseUrl: server.baseUrl, apiKeyEnv: "OMP_REVIEW_JEV_KEY" };
    delete process.env.OMP_REVIEW_JEV_KEY;
    assert.equal(await reviewWithJev(payloadFor(), keyless, 10_000, new AbortController().signal, a => attempts.push({ ...a })), undefined);
    // Nothing was attempted, so nothing is reported as a failure either.
    assert.equal(server.requests.length, 0);
    assert.equal(attempts.length, 0);
    process.env.OMP_REVIEW_JEV_KEY = "from-env";
    assert.ok(await reviewWithJev(payloadFor(), { ...keyless, apiKey: "from-config" }, 10_000, new AbortController().signal));
    assert.equal(server.requests.at(-1)!.headers.authorization, "Bearer from-env");
    delete process.env.OMP_REVIEW_JEV_KEY;
    assert.ok(await reviewWithJev(payloadFor(), { ...keyless, apiKey: "from-config" }, 10_000, new AbortController().signal));
    assert.equal(server.requests.at(-1)!.headers.authorization, "Bearer from-config");
  } finally { delete process.env.OMP_REVIEW_JEV_KEY; await server.close(); }
});

test("a budget smaller than one attempt skips the prefilter", async () => {
  const server = await jevServer(() => ({}));
  try {
    assert.equal(await reviewWithJev(payloadFor(), jevFor(server.baseUrl), 0, new AbortController().signal), undefined);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});


test("the shipped example configuration is valid and matches the documented defaults", async () => {
  // A broken example would be copied straight into a user configuration, so it is checked here.
  const example = JSON.parse(await readFile(new URL("../examples/auto-review.json", import.meta.url), "utf8"));
  const parsed = parseConfig(example);
  assert.deepEqual(parsed.jev, { ...jevDefaults });
  // The example must also satisfy the budget rule it is meant to illustrate.
  assert.ok(jevBudgetMs(parsed.jev) < parsed.reviewTimeoutMs);
  assert.ok(parsed.reviewTimeoutMs + parsed.confirmationTimeoutMs <= 110_000);
});
