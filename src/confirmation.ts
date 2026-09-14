import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// An expired recommendation timer must stay distinct from Escape, dialog errors and
// cancellation, so an automatic decision is never recorded as a human one. The dialog
// shares the recommendation delay as its own timeout so its countdown matches the
// advertised wait, but its expiry only closes the dialog: the host would otherwise
// select the highlighted option, which can be the recommended approval.
export async function selectConfirmation(
  ctx: ExtensionContext, title: string, signal: AbortSignal, timeout: number, recommendationDelay: number,
  recommendation?: "approve" | "deny",
): Promise<"approve" | "deny" | "recommendation"> {
  const dialog = new AbortController();
  const cancel = () => dialog.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) dialog.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Own the expiry: the host answers with the highlighted row, which is the recommended
    // approval whenever the model suggested one, and without auto-decisions the expiry must
    // deny. The local timer is armed before the dialog is presented and provides the expiry
    // result; the dialog's own expiry below is a fail-closed cancel, never an answer.
    const expired = new Promise<"recommendation" | "deny">(resolve => {
      timer = setTimeout(() => resolve(recommendationDelay ? "recommendation" : "deny"), recommendationDelay || timeout);
    });
    const denyLabel = `拒绝执行${recommendation === "deny" ? "（模型建议）" : ""}`;
    const approveLabel = `仅批准本次调用${recommendation === "approve" ? "（模型建议）" : ""}`;
    const selection = ctx.ui.select(title, [denyLabel, approveLabel], {
      initialIndex: recommendation === "approve" ? 1 : 0, signal: dialog.signal, timeout: recommendationDelay || timeout,
      // The host selects the highlighted row on expiry; that row can be the recommended
      // approval, so expire into a plain cancel instead. Cancelling settles `undefined`,
      // which maps to deny, and the local timer stays the only source of "recommendation".
      onTimeout: () => dialog.abort(),
    }).then(choice => choice === approveLabel ? "approve" as const : "deny" as const);
    // race attaches handlers to both inputs, so a late rejection of the losing dialog
    // promise after the timer wins cannot surface as unhandled.
    return await Promise.race([expired, selection]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    dialog.abort();
  }
}
