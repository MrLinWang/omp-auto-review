import { test } from "node:test";
import assert from "node:assert/strict";
import { selectConfirmation } from "../src/confirmation.ts";
import { context } from "./helpers.ts";

test("recommendation labels map choices correctly and the recommended option is selected", async () => {
  for (const recommendation of ["approve", "deny", undefined] as const) {
    for (const selected of [0, 1, undefined]) {
      const c = context("/work", async (_title, options, settings) => {
        assert.equal(settings.initialIndex, recommendation === "approve" ? 1 : 0);
        assert.deepEqual(options, [
          recommendation === "deny" ? "拒绝执行（模型建议）" : "拒绝执行",
          recommendation === "approve" ? "仅批准本次调用（模型建议）" : "仅批准本次调用",
        ]);
        return selected === undefined ? undefined : options[selected];
      });
      assert.equal(await selectConfirmation(c.ctx, "review", new AbortController().signal, 1000, 0, recommendation),
        selected === 1 ? "approve" : "deny");
    }
  }
});

// Mirrors the host: expiry calls `onTimeout` and then answers with the highlighted row,
// while an aborted dialog settles as a cancel and that later answer is ignored.
function hostExpiry() {
  return (_title: string, options: string[], settings: {
    initialIndex: number; signal: AbortSignal; onTimeout?: () => void;
  }) => new Promise<string | undefined>(resolve => {
    let settled = false;
    const finish = (value: string | undefined) => { if (!settled) { settled = true; resolve(value); } };
    settings.signal.addEventListener("abort", () => finish(undefined), { once: true });
    settings.onTimeout?.();
    finish(options[settings.initialIndex]);
  });
}

test("host expiry that highlights the recommended approval can never approve", async () => {
  // Automatic decisions disabled: the expiry must deny instead of following the highlight.
  const manual = context("/work", hostExpiry());
  assert.equal(await selectConfirmation(manual.ctx, "review", new AbortController().signal, 1000, 0, "approve"), "deny");
  // With automatic decisions a host expiry degrades to a cancel; the recommendation
  // itself only ever comes from the local timer.
  const automatic = context("/work", hostExpiry());
  assert.equal(await selectConfirmation(automatic.ctx, "review", new AbortController().signal, 1000, 30, "approve"), "deny");
});
