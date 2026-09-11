import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { reviewReasoning } from "../src/thinking.ts";

type Thinking = NonNullable<Model<Api>["thinking"]>;
const thinking = (efforts: string[]): Thinking => ({ mode: "effort", efforts } as Thinking);

test("review uses the lowest supported effort, including models without low", () => {
  for (const [efforts, expected] of [
    [["high", "xhigh", "max"], "high"],
    [["max", "high", "low"], "low"],
    [["low", "minimal", "high"], "minimal"],
    [["max", "medium"], "medium"],
    [["xhigh", "max"], "xhigh"],
    [["max"], "max"],
  ] as const) {
    const metadata = thinking([...efforts]);
    assert.equal(reviewReasoning({ reasoning: true, thinking: metadata }), expected);
    assert.deepEqual(metadata.efforts, efforts);
  }
});

test("review omits effort for non-reasoning models and models without effort controls", () => {
  assert.equal(reviewReasoning({ reasoning: false, thinking: thinking(["high"]) }), undefined);
  assert.equal(reviewReasoning({ reasoning: true }), undefined);
  assert.equal(reviewReasoning({ reasoning: true, thinking: thinking([]) }), undefined);
});

test("review selects a declared effort and preserves provider mapping metadata", () => {
  const metadata = { ...thinking(["max", "xhigh"]), effortMap: { xhigh: "max" } };
  assert.equal(reviewReasoning({ reasoning: true, thinking: metadata }), "xhigh");
  assert.deepEqual(metadata.effortMap, { xhigh: "max" });
});
