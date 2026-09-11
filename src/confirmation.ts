import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// An expired recommendation timer must stay distinct from Escape, dialog errors and
// cancellation, so an automatic decision is never recorded as a human one. The dialog
// shares the recommendation delay as its own timeout so its countdown matches the
// advertised wait.
export async function selectConfirmation(
  ctx: ExtensionContext, title: string, signal: AbortSignal, timeout: number, recommendationDelay: number,
): Promise<"approve" | "deny" | "recommendation"> {
  const dialog = new AbortController();
  const cancel = () => dialog.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) dialog.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const automatic = recommendationDelay ? new Promise<"recommendation">(resolve => {
      timer = setTimeout(() => resolve("recommendation"), recommendationDelay);
    }) : undefined;
    const selection = ctx.ui.select(title, ["拒绝执行", "仅批准本次调用"], {
      initialIndex: 0, signal: dialog.signal, timeout: recommendationDelay || timeout,
    }).then(choice => choice === "仅批准本次调用" ? "approve" as const : "deny" as const);
    if (!automatic) return await selection;
    // race attaches handlers to both inputs, so a late rejection of the losing dialog
    // promise after the timer wins cannot surface as unhandled.
    return await Promise.race([automatic, selection]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    dialog.abort();
  }
}
