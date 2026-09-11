import type { AgentRegistry, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { fingerprint } from "./privacy.ts";

export function isUserEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  if (e.type !== "message" && e.type !== "auto_review_ancestor_user") return false;
  const m = e.message as Record<string, unknown> | undefined;
  return m?.role === "user" && m.attribution !== "agent";
}

/** Follow host-owned parent references, never a model-supplied path or claimed parent ID. */
export function collectHistory(ctx: ExtensionContext, registry: Pick<AgentRegistry, "list" | "get">): unknown[] {
  const own = ctx.sessionManager.getBranch();
  const matches = registry.list().filter(ref => ref.session?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId());
  if (matches.length !== 1) return own;
  let ref = matches[0];
  const seen = new Set([ref.id]);
  const inherited: unknown[] = [];
  while (ref.parentId && seen.size < 16) {
    const parent = registry.get(ref.parentId);
    if (!parent?.session || seen.has(parent.id)) break;
    seen.add(parent.id);
    const manager = parent.session.sessionManager;
    inherited.unshift(...manager.getBranch().filter(isUserEntry).map(entry => ({
      type: "auto_review_ancestor_user", sourceSessionId: manager.getSessionId(),
      message: (entry as unknown as { message: unknown }).message,
    })));
    ref = parent;
  }
  return [...inherited, ...own];
}

export function authorityFingerprint(history: unknown[]): string {
  return fingerprint(history.filter(isUserEntry));
}
