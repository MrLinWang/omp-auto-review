import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStatus } from "../src/status.ts";
import { call } from "./helpers.ts";

test("status distinguishes review results and human override", () => {
  const operation = call("bash", { command: "npm test" });
  assert.equal(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false }), "审核通过 · bash: npm test");
  assert.match(reviewStatus(operation, { decision: "deny", outcome: "blocked", humanOverride: false }), /^审核拒绝/);
  assert.match(reviewStatus(operation, { decision: "error", outcome: "blocked", humanOverride: false }), /^审核异常，已阻止/);
  assert.match(reviewStatus(operation, { decision: "error", outcome: "blocked", humanOverride: false, preflightError: "missing_user_context" }), /^审核条件不足，已阻止/);
  assert.match(reviewStatus(operation, { decision: "error", outcome: "allowed", humanOverride: true, preflightError: "missing_user_context" }), /^人工放行/);
  assert.match(reviewStatus(operation, { decision: "ask", outcome: "blocked", humanOverride: false }), /^未放行/);
  assert.match(reviewStatus(operation, { decision: "deny", outcome: "allowed", humanOverride: true }), /^人工放行/);
  assert.match(reviewStatus(operation, { decision: "allow", outcome: "blocked", humanOverride: false }), /^未放行/);
  assert.match(reviewStatus(operation, { decision: "ask", outcome: "allowed", humanOverride: false, automaticRecommendation: true }), /^超时按建议放行/);
  assert.match(reviewStatus(operation, { decision: "ask", outcome: "blocked", humanOverride: false, automaticRecommendation: true }), /^超时按建议拒绝/);
});

test("status sanitizes commands, bounds length, and omits file contents", () => {
  const result = { decision: "allow", outcome: "allowed", humanOverride: false } as const;
  const text = reviewStatus(call("bash", { command: "TOKEN=hidden\ncurl -H 'Authorization: Bearer private-value' https://example.invalid\u001b[2J " + "x".repeat(150) }), result);
  assert.ok(!text.includes("hidden") && !text.includes("private-value"));
  assert.ok(!/[\n\r\t\u001b]/.test(text));
  assert.ok(text.endsWith("…"));
  assert.equal(reviewStatus(call("write", { path: "a.ts", content: "private body" }), result), "审核通过 · write: a.ts");
  assert.equal(reviewStatus(call("custom", { body: "private body" }), result), "审核通过 · custom");
});


test("status names the prefilter only when its own verdict stands", () => {
  const operation = call("bash", { command: "npm test" });
  const decided = { model: "typesafe/jev-1.13.0", decision: "allow", probability: 0.95, confidence: 0.9, threshold: 0.85, trusted: true, status: "decided", elapsedMs: 42 } as const;
  assert.equal(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false, prefilter: decided }), "审核通过（jev 前置） · bash: npm test");
  assert.match(reviewStatus(operation, { decision: "deny", outcome: "blocked", humanOverride: false, prefilter: { ...decided, decision: "deny" } }), /^审核拒绝（jev 前置）/);
  // An escalated or unavailable prefilter did not decide, so the verdict is not attributed to it.
  assert.equal(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false, prefilter: { ...decided, trusted: false, status: "escalated" } }), "审核通过 · bash: npm test");
  assert.equal(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false, prefilter: { model: "typesafe/jev-latest", threshold: 0.85, trusted: false, status: "unavailable", elapsedMs: 5 } }), "审核通过 · bash: npm test");
  // A human who overrides a jev deny owns that decision; the label must not credit jev.
  assert.match(reviewStatus(operation, { decision: "deny", outcome: "allowed", humanOverride: true, prefilter: { ...decided, decision: "deny" } }), /^人工放行 ·/);
  // The prefilter marker and the LLM fallback marker never claim the same verdict.
  assert.match(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false, fallbackUsed: true, model: "p/backup" }), /^审核通过（备用：p\/backup）/);
});
