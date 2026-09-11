import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStatus } from "../src/status.ts";
import { call } from "./helpers.ts";

test("status distinguishes review results and human override", () => {
  const operation = call("bash", { command: "npm test" });
  assert.equal(reviewStatus(operation, { decision: "allow", outcome: "allowed", humanOverride: false }), "审核通过 · bash: npm test");
  assert.match(reviewStatus(operation, { decision: "deny", outcome: "blocked", humanOverride: false }), /^审核拒绝/);
  assert.match(reviewStatus(operation, { decision: "error", outcome: "blocked", humanOverride: false }), /^审核异常，已阻止/);
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
