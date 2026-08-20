/**
 * gate-budget.mjs — budget tiers + AA-seed latency table + effort picker.
 *
 * Seed provenance: artificialanalysis.ai model leaderboards
 * (https://artificialanalysis.ai/leaderboards/models) and the performance
 * methodology (https://artificialanalysis.ai/methodology/performance-benchmarking),
 * consulted 2026-08-20. AA measures direct-API P50 over 72h from
 * us-central1 with 1k/10k/100k-token workloads, ~500-answer-token E2E
 * assumptions, tiktoken o200k_base counting.
 *
 * Conversion to our review workload (10k-100k input tokens, ~500 output
 * tokens incl. a verdict envelope):
 *   expected_ms ≈ TTFT(effort) + reasoning_tokens(effort)/reasoning_speed
 *                 + 500/output_speed
 * then ×1.5 safety factor for app-server indirection + user-network
 * overhead (AA is a datacenter client; we are not).
 *
 * These numbers are SEED ONLY — the OS-global learner (gate-learner.mjs)
 * replaces them with measured latencies after burn-in (n ≥ 5 per key).
 * They are intentionally conservative (slower = safer picks).
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */

export const BUDGET_TIERS = Object.freeze({
  major: 15 * 60_000, // 大研发阶段 planning & completion: 15 min
  minor: 10 * 60_000, // 小研发阶段 planning & completion: 10 min
  other: 60_000, // 其他对象: 1 min
  realtime: 30_000 // 实时输出段: ~30s window → analyze within 25s (0.8×)
});

export const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * Reasoning-token assumptions per effort (order-of-magnitude, from AA
 * "Average Reasoning Tokens" concept; codex models are heavy reasoners).
 * Used only inside the seed derivation below — documented, not magic.
 */
const SEED_REASONING_TOKENS = {
  none: 0,
  minimal: 200,
  low: 1000,
  medium: 4000,
  high: 12000,
  xhigh: 30000
};

/**
 * Per-model seed parameters (conservative P50s, tokens/sec, o200k_base).
 * "*" is the default row for unknown models.
 */
const SEED_MODELS = {
  "gpt-5.3-codex": { ttft_s: 2.0, out_speed: 90 },
  "gpt-5.3-codex-spark": { ttft_s: 0.7, out_speed: 140 },
  "gpt-5.2": { ttft_s: 2.5, out_speed: 70 },
  "gpt-5.1": { ttft_s: 3.0, out_speed: 60 },
  "*": { ttft_s: 3.0, out_speed: 55 }
};

const SAFETY = 1.5;

/** Seed expected latency (ms) for (model, effort) on a standard review call. */
export function seedExpectedMs(model, effort) {
  const row = SEED_MODELS[model] ?? SEED_MODELS["*"];
  const reasoning = SEED_REASONING_TOKENS[effort] ?? SEED_REASONING_TOKENS["medium"];
  // reasoning tokens stream at roughly out_speed; answer ~500 tokens after.
  const seconds = row.ttft_s + reasoning / row.out_speed + 500 / row.out_speed;
  return Math.round(seconds * 1000 * SAFETY);
}

/**
 * Pick the best effort for (model, budgetMs).
 * Policy: the HIGHEST effort whose expected latency fits budget×0.8;
 * if none fits, the LOWEST effort and flag budgetMiss.
 */
export function pickEffort(model, budgetMs, options = {}) {
  const learned = options.learnedExpectedMs; // fn(effort) -> ms | undefined (learner)
  const usable = options.efforts ?? EFFORTS;
  const expected = (effort) => learned?.(effort) ?? seedExpectedMs(model, effort);
  const limit = budgetMs * 0.8;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const effort = usable[i];
    if (expected(effort) <= limit) {
      return { effort, budgetMiss: false, expectedMs: expected(effort), source: learned?.(effort) != null ? "learner" : "seed" };
    }
  }
  const effort = usable[0];
  return { effort, budgetMiss: true, expectedMs: expected(effort), source: learned?.(effort) != null ? "learner" : "seed" };
}

export function tierForStage(stage, tier) {
  if (tier === "realtime") return "realtime";
  return BUDGET_TIERS[tier] ? tier : "other";
}

export function objclassFor(stage, tier) {
  const t = tierForStage(stage, tier);
  if (stage === "follow") return "realtime";
  return `${stage}-${t}`;
}
