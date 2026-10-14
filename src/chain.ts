import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewConfig } from "./config.ts";
import { buildReviewPayload, ReviewPreparationError, type ReviewRequest, type Verdict } from "./reviewer.ts";
import { jevVerdict, reviewWithJev, type JevCandidate, type PrefilterObserver } from "./jev.ts";
import type { AttemptObserver } from "./attempt.ts";

/** The LLM layer, injected so the chain stays independent of the provider SDK. */
export type LlmReviewer = (
  content: string, request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext,
  signal: AbortSignal, onAttempt: AttemptObserver | undefined, budgetMs: number,
) => Promise<Verdict>;

export type ReviewChain = (
  request: ReviewRequest, config: ReviewConfig, ctx: ExtensionContext, signal: AbortSignal,
  onAttempt?: AttemptObserver, onPrefilter?: PrefilterObserver,
) => Promise<Verdict>;

/**
 * The jev prefilter decides only when the winning probability meets the configured threshold
 * and confidence is at least 0.5. A trusted `deny` blocks without a human confirmation;
 * an uncertain answer or exhausted native candidates falls through to the LLM chain with
 * whatever review budget the prefilter did not spend.
 *
 * `selectJev` supplies native candidates from OMP's `judge` role chain. An empty selection
 * produces no prefilter attempt or record.
 */
export function prefilterChain(llm: LlmReviewer, selectJev: (ctx: ExtensionContext) => readonly JevCandidate[]): ReviewChain {
  return async (request, config, ctx, signal, onAttempt, onPrefilter) => {
    const jev = config.jev && config.jev.enabled !== false ? config.jev : undefined;
    if (!jev && !config.model) throw new ReviewPreparationError("model_not_configured");
    // One redacted payload for both layers, so the budget checks run exactly once.
    const payload = buildReviewPayload(request, config);
    const started = Date.now();
    let answered = false;
    if (jev) {
      const candidates = selectJev(ctx);
      // Availability comes from the host pool: with no native candidate the prefilter leaves no trace.
      if (candidates.length > 0) {
        const outcome = await reviewWithJev(payload, jev, candidates, config.reviewTimeoutMs, signal, onAttempt);
        answered = outcome !== undefined;
        onPrefilter?.({
          model: outcome?.model ?? candidates[0].model,
          ...(outcome ? { decision: outcome.gate.decision, probability: outcome.gate.probability, confidence: outcome.gate.confidence } : {}),
          threshold: jev.confidenceThreshold,
          trusted: outcome?.gate.trusted === true,
          status: outcome ? (outcome.gate.trusted ? "decided" : "escalated") : "unavailable",
          elapsedMs: Date.now() - started,
        });
        // The versioned ID that actually answered is what the audit records.
        if (outcome?.gate.trusted) return { ...jevVerdict(outcome.gate, outcome.model), reviewerModel: `jev:${outcome.model}` };
      }
    }
    // A cancelled review must not continue into the LLM chain, whatever skipped the prefilter.
    if (signal.aborted) throw new Error("审核已取消");
    // An uncertain prefilter with no LLM behind it is a distinct, reportable state.
    if (!config.model) throw new ReviewPreparationError(answered ? "prefilter_low_confidence" : "model_not_configured");
    return llm(JSON.stringify(payload), request, config, ctx, signal, onAttempt,
      Math.max(1, config.reviewTimeoutMs - (Date.now() - started)));
  };
}
