/**
 * gate-verdict.mjs — the one verdict contract for the whole plugin family.
 *
 * Envelope (what Codex must return, and what every host consumes):
 * {
 *   "verdict": "pass" | "fail",
 *   "stage": "plan" | "follow" | "completion",
 *   "confidence": 0..1,
 *   "reasons": ["..."],
 *   "deviation_summary": "..." (stage=fail on follow/completion),
 *   "recommendation": "proceed" | "revise-plan" | "halt-chain" | "continue-fixing"
 * }
 *
 * Runtime always stamps: { model, effort_used, elapsed_ms, timed_out,
 * source: "codex"|"timeout-failopen", objclass, budget_ms }.
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */

export const VERDICT_VALUES = new Set(["pass", "fail"]);
export const STAGES = new Set(["plan", "follow", "completion"]);
export const RECOMMENDATIONS = new Set([
  "proceed",
  "revise-plan",
  "halt-chain",
  "continue-fixing"
]);

/** Extract the first JSON object from arbitrary model text (fences tolerated). */
export function extractJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Parse + validate a raw envelope object. Returns a normalized envelope or
 * throws Error("invalid-verdict: ..."). Never guesses: malformed => throw.
 */
export function normalizeVerdict(raw, context = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid-verdict: envelope is not an object");
  }
  const verdict = String(raw.verdict ?? "").toLowerCase();
  if (!VERDICT_VALUES.has(verdict)) {
    throw new Error(`invalid-verdict: verdict must be pass|fail, got ${JSON.stringify(raw.verdict)}`);
  }
  const stage = String(raw.stage ?? context.stage ?? "").toLowerCase();
  if (!STAGES.has(stage)) {
    throw new Error(`invalid-verdict: stage must be plan|follow|completion, got ${JSON.stringify(stage)}`);
  }
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.map((r) => String(r)).filter((r) => r.length > 0)
    : [];
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  let recommendation = String(raw.recommendation ?? "").toLowerCase();
  if (!RECOMMENDATIONS.has(recommendation)) {
    recommendation = defaultRecommendation(verdict, stage);
  }
  return {
    verdict,
    stage,
    confidence,
    reasons,
    deviation_summary: typeof raw.deviation_summary === "string" ? raw.deviation_summary : null,
    recommendation,
    model: context.model ?? null,
    effort_used: context.effort ?? null,
    elapsed_ms: context.elapsed_ms ?? null,
    budget_ms: context.budget_ms ?? null,
    timed_out: Boolean(context.timed_out),
    source: context.source ?? "codex",
    objclass: context.objclass ?? null
  };
}

/** Parse model output text into an envelope (throws on malformed). */
export function parseVerdictText(text, context = {}) {
  const raw = extractJson(text);
  if (!raw) {
    throw new Error("invalid-verdict: no JSON object found in model output");
  }
  return normalizeVerdict(raw, context);
}

function defaultRecommendation(verdict, stage) {
  if (verdict === "pass") {
    return stage === "completion" ? "proceed" : "proceed";
  }
  if (stage === "plan") return "revise-plan";
  if (stage === "follow") return "halt-chain";
  return "continue-fixing";
}

/** Machine-checkable one-liner (used by hosts to branch). */
export function isPass(envelope) {
  return envelope?.verdict === "pass";
}
