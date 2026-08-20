/**
 * gate-core.mjs — gate runtime: runs a gated Codex turn per stage.
 *
 * Wraps the vendored companion runtime (runAppServerTurn) with:
 *   - effort selection (learner-first, AA-seed fallback, user override)
 *   - wall-clock budget enforcement with fail-open timeouts
 *   - verdict parsing/validation + learner recording
 *
 * Host integrations (hooks/extensions/skills) call runStage(); they never
 * talk to the app-server directly.
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */
import { runAppServerTurn } from "../codex.mjs";
import { BUDGET_TIERS, objclassFor, pickEffort, tierForStage } from "./gate-budget.mjs";
import {
  BURN_IN,
  chooseEffort,
  learnedExpectedMs,
  loadState,
  recordAndSave,
  renderStatus as renderLearnerStatus,
  resetStore
} from "./gate-learner.mjs";
import {
  buildCompletionGatePrompt,
  buildFollowGatePrompt,
  buildPlanGatePrompt
} from "./gate-prompt.mjs";
import { normalizeVerdict, parseVerdictText } from "./gate-verdict.mjs";

export const GATE_HOST_NAME = "codex-plugin"; // overridden per-repo via options.host
export const FAIL_OPEN_DEFAULT = true;

function resolveBudget(stage, options) {
  if (options.budgetMs && options.budgetMs > 0) return Math.round(options.budgetMs);
  const tier = tierForStage(stage, options.tier ?? (stage === "follow" ? "realtime" : "other"));
  return BUDGET_TIERS[tier];
}

function resolveEffort(objclass, stage, options, budgetMs) {
  if (options.effort) {
    return { effort: options.effort, source: "override", expectedMs: null, budgetMiss: false };
  }
  const state = loadState();
  const models = options.model ? [options.model] : [];
  const chosen = chooseEffort(state, objclass, budgetMs, models, pickEffort);
  return chosen;
}

async function turnWithBudget(runPromise, budgetMs, onTimeout) {
  let timer = null;
  try {
    return await Promise.race([
      runPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), budgetMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run one gate stage. Returns a verdict envelope (pass|fail) or throws on
 * infrastructure errors (codex missing). Timeout → fail-open pass envelope
 * with timed_out=true, source="timeout-failopen" (configurable).
 */
export async function runStage(stage, input, options = {}) {
  const started = Date.now();
  const tier = tierForStage(stage, input.tier ?? (stage === "follow" ? "realtime" : "other"));
  const budgetMs = resolveBudget(stage, input);
  const objclass = objclassFor(stage, tier);
  const { effort, source: effortSource } = resolveEffort(objclass, stage, input, budgetMs);

  const prompt = buildPrompt(stage, input, budgetMs);
  const run = runAppServerTurn(input.cwd ?? process.cwd(), {
    prompt,
    model: input.model ?? null,
    effort,
    persistThread: false,
    threadName: null,
    onProgress: input.onProgress,
    disableBroker: true // one-shot verdict; never leak a shared broker
  });

  const failOpen = input.failOpen ?? options.failOpen ?? FAIL_OPEN_DEFAULT;
  const outcome = await turnWithBudget(run, budgetMs);

  const elapsed = Date.now() - started;
  if (outcome?.__timeout) {
    if (failOpen) {
      return stampEnvelope(
        normalizeVerdict(
          {
            verdict: "pass",
            stage,
            confidence: 0.2,
            reasons: [`analysis exceeded budget (${budgetMs}ms); fail-open pass`],
            recommendation: stage === "plan" ? "proceed" : stage === "follow" ? "proceed" : "proceed"
          },
          { stage, model: input.model ?? "default", effort, elapsed_ms: elapsed, budget_ms: budgetMs, timed_out: true, source: "timeout-failopen", objclass }
        ),
        { effortSource, host: options.host }
      );
    }
    return stampEnvelope(
      normalizeVerdict(
        {
          verdict: "fail",
          stage,
          confidence: 0.5,
          reasons: [`analysis exceeded budget (${budgetMs}ms) and fail-open is disabled`],
          recommendation: stage === "follow" ? "halt-chain" : "continue-fixing"
        },
        { stage, model: input.model ?? "default", effort, elapsed_ms: elapsed, budget_ms: budgetMs, timed_out: true, source: "timeout", objclass }
      ),
      { effortSource, host: options.host }
    );
  }

  const turn = outcome;
  const finalMessage = turn.finalMessage ?? "";
  let envelope;
  try {
    envelope = parseVerdictText(finalMessage, {
      stage,
      model: input.model ?? "default",
      effort,
      elapsed_ms: elapsed,
      budget_ms: budgetMs,
      objclass
    });
  } catch {
    // Malformed verdict: treat as infra failure of the gate itself → fail-open.
    const fallback = normalizeVerdict(
      {
        verdict: failOpen ? "pass" : "fail",
        stage,
        confidence: 0.1,
        reasons: [
          "Codex returned a malformed verdict envelope",
          short(finalMessage) || `turn status ${turn.status ?? "?"}${turn.error ? `: ${short(turn.error)}` : ""}`
        ]
      },
      {
        stage,
        model: input.model ?? null,
        effort,
        elapsed_ms: elapsed,
        budget_ms: budgetMs,
        objclass,
        source: failOpen ? "malformed-failopen" : "malformed"
      }
    );
    envelope = stampEnvelope(fallback, { effortSource, host: options.host });
    recordLearnerSample(objclass, envelope, options);
    return envelope;
  }
  envelope = stampEnvelope(envelope, { effortSource, host: options.host });
  recordLearnerSample(objclass, envelope, options);
  return envelope;
}

function buildPrompt(stage, input, budgetMs) {
  if (stage === "plan") {
    return buildPlanGatePrompt({ plan: input.plan ?? input.text ?? "", tier: input.tier ?? "other", context: input.context });
  }
  if (stage === "follow") {
    return buildFollowGatePrompt({
      plan: input.plan ?? "",
      segment: input.segment ?? "",
      opSummary: input.opSummary ?? null,
      budgetMs
    });
  }
  if (stage === "completion") {
    return buildCompletionGatePrompt({
      plan: input.plan ?? "",
      summary: input.summary ?? "",
      diff: input.diff ?? "",
      tier: input.tier ?? "other"
    });
  }
  throw new Error(`Unknown gate stage: ${stage}`);
}

function recordLearnerSample(objclass, envelope, options) {
  if (options.noLearn || envelope.timed_out) return; // timeouts pollute latency stats
  if (!envelope.model || !envelope.effort_used || envelope.elapsed_ms == null) return;
  try {
    recordAndSave(`${objclass}|${envelope.model}|${envelope.effort_used}`, envelope.elapsed_ms, options.host ?? GATE_HOST_NAME);
  } catch {
    /* learner failures never break the gate */
  }
}

function stampEnvelope(envelope, meta) {
  return { ...envelope, effort_source: meta.effortSource ?? null, _host: meta.host ?? null };
}

function short(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** Exposed for hosts/tests. */
export function learnerStatus() {
  return renderLearnerStatus(loadState());
}

export function learnerReset() {
  return resetStore();
}

export function learnerBurnIn() {
  return BURN_IN;
}

export function learnerExpected(objclass, model, effort) {
  return learnedExpectedMs(loadState(), objclass, model, effort);
}
