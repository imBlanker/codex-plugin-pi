import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { extractJson, normalizeVerdict, parseVerdictText } from "../lib/gate/gate-verdict.mjs";
import { BUDGET_TIERS, objclassFor, pickEffort, seedExpectedMs } from "../lib/gate/gate-budget.mjs";
import {
  BURN_IN,
  emptyState,
  learnedExpectedMs,
  loadState,
  recordAndSave,
  recordSample,
  renderStatus,
  resetStore
} from "../lib/gate/gate-learner.mjs";
import {
  buildCompletionGatePrompt,
  buildFollowGatePrompt,
  buildPlanGatePrompt
} from "../lib/gate/gate-prompt.mjs";

/* ------------------------------ verdict ------------------------------ */

test("extractJson handles fenced, raw and noisy JSON", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前置文字 {"a":1} 后置文字'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
});

test("normalizeVerdict validates and defaults", () => {
  const v = normalizeVerdict({ verdict: "PASS", stage: "plan", reasons: ["ok", "", 3] }, { stage: "plan" });
  assert.equal(v.verdict, "pass");
  assert.deepEqual(v.reasons, ["ok", "3"]);
  assert.equal(v.recommendation, "proceed");
  const f = normalizeVerdict({ verdict: "fail", stage: "follow" });
  assert.equal(f.recommendation, "halt-chain");
  const c = normalizeVerdict({ verdict: "fail", stage: "completion" });
  assert.equal(c.recommendation, "continue-fixing");
  const p2 = normalizeVerdict({ verdict: "fail", stage: "plan" });
  assert.equal(p2.recommendation, "revise-plan");
});

test("normalizeVerdict rejects malformed envelopes", () => {
  assert.throws(() => normalizeVerdict({ verdict: "maybe" }), /invalid-verdict/);
  assert.throws(() => normalizeVerdict({ verdict: "pass", stage: "nope" }), /invalid-verdict/);
  assert.throws(() => normalizeVerdict(null), /invalid-verdict/);
});

test("parseVerdictText from model text with fence", () => {
  const text = '分析如下…\n```json\n{"verdict":"pass","stage":"plan","confidence":0.9,"reasons":["solid"]}\n```';
  const v = parseVerdictText(text, { stage: "plan", model: "m", effort: "high", elapsed_ms: 1000 });
  assert.equal(v.verdict, "pass");
  assert.equal(v.model, "m");
  assert.equal(v.effort_used, "high");
  assert.equal(v.elapsed_ms, 1000);
  assert.throws(() => parseVerdictText("totally not json"), /invalid-verdict/);
});

/* ------------------------------ budget ------------------------------ */

test("budget tiers match the user's numbers", () => {
  assert.equal(BUDGET_TIERS.major, 15 * 60_000);
  assert.equal(BUDGET_TIERS.minor, 10 * 60_000);
  assert.equal(BUDGET_TIERS.other, 60_000);
  assert.equal(BUDGET_TIERS.realtime, 30_000);
});

test("objclass composes stage+tier", () => {
  assert.equal(objclassFor("follow", "major"), "realtime");
  assert.equal(objclassFor("plan", "minor"), "plan-minor");
  assert.equal(objclassFor("completion", "other"), "completion-other");
});

test("seedExpectedMs monotonic in effort and conservative", () => {
  for (const model of ["gpt-5.3-codex", "unknown-model"]) {
    let prev = -1;
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
      const ms = seedExpectedMs(model, effort);
      assert.ok(ms > prev, `${model} ${effort} should grow`);
      prev = ms;
    }
  }
  // conservative: spark xhigh definitely exceeds a 25s realtime analysis slot
  assert.ok(seedExpectedMs("gpt-5.3-codex-spark", "xhigh") > 25_000 * 0.8);
});

test("pickEffort chooses highest fitting effort, flags budgetMiss", () => {
  const p1 = pickEffort("gpt-5.3-codex", 15 * 60_000); // major tier
  assert.equal(p1.effort, "xhigh");
  assert.equal(p1.budgetMiss, false);
  const p2 = pickEffort("gpt-5.3-codex", 20_000); // tight: must step down
  assert.notEqual(p2.effort, "xhigh");
  assert.equal(p2.budgetMiss, false);
  const p3 = pickEffort("gpt-5.3-codex", 100); // impossible: lowest + flag
  assert.equal(p3.effort, "none");
  assert.equal(p3.budgetMiss, true);
  // learner data overrides seed
  const learned = (effort) => (effort === "xhigh" ? 5000 : undefined);
  const p4 = pickEffort("gpt-5.3-codex", 20_000, { learnedExpectedMs: learned });
  assert.equal(p4.effort, "xhigh");
  assert.equal(p4.source, "learner");
});

/* ------------------------------ learner ------------------------------ */

function tmpLearnerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-learner-test-"));
}

test("learner records samples with Welford+EMA and gates burn-in", () => {
  const state = emptyState();
  for (let i = 1; i <= BURN_IN; i += 1) recordSample(state, "plan-major|m|high", 1000 * i, "test-host");
  const s = state.samples["plan-major|m|high"];
  assert.equal(s.n, BURN_IN);
  assert.ok(Number.isFinite(s.mean_ms));
  assert.ok(learnedExpectedMs(state, "plan-major", "m", "high") >= 1000);
  // below burn-in → null
  recordSample(state, "realtime|m|low", 100, "test-host");
  assert.equal(learnedExpectedMs(state, "realtime", "m", "low"), null);
  // host history recorded
  assert.ok(state.hostHistory.some((h) => h.host === "test-host"));
});

test("learner persists across processes and resets with backup", () => {
  const dir = tmpLearnerDir();
  const key = "completion-minor|m|medium";
  recordAndSave(key, 4321, "host-a", { dir });
  const loaded = loadState({ dir });
  assert.equal(loaded.samples[key].n, 1);
  assert.equal(loaded.samples[key].last_ms, 4321);
  // cross-host write
  recordAndSave(key, 5000, "host-b", { dir });
  const loaded2 = loadState({ dir });
  assert.equal(loaded2.samples[key].n, 2);
  assert.ok(loaded2.hostHistory.some((h) => h.host === "host-b"));
  // reset keeps backup
  resetStore({ dir });
  assert.equal(loadState({ dir }).samples[key], undefined);
  const backups = fs.readdirSync(dir).filter((f) => f.includes("backup-"));
  assert.equal(backups.length, 1);
  // corruption recovery
  fs.writeFileSync(path.join(dir, "learner.json"), "{broken");
  const recovered = loadState({ dir });
  assert.equal(recovered.version, 1);
  assert.deepEqual(recovered.samples, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renderStatus produces compact lines", () => {
  const state = emptyState();
  recordSample(state, "plan-other|m2|low", 900, "host-x");
  const text = renderStatus(state);
  assert.match(text, /plan-other\|m2\|low: n=1/);
  assert.match(text, /hosts seen: host-x/);
});

/* ------------------------------ prompts ------------------------------ */

test("prompt builders embed contract and inputs", () => {
  const plan = buildPlanGatePrompt({ plan: "STEP 1 do x", tier: "minor", context: "repo ctx" });
  assert.match(plan, /plan-approval gate/);
  assert.match(plan, /STEP 1 do x/);
  assert.match(plan, /"verdict": "pass" \| "fail"/);

  const follow = buildFollowGatePrompt({ plan: "P", segment: "error: boom", opSummary: "npm test", budgetMs: 30000 });
  assert.match(follow, /realtime output gate/);
  assert.match(follow, /error: boom/);
  assert.match(follow, /30s wall-clock/);

  const completion = buildCompletionGatePrompt({ plan: "P", summary: "done", diff: "+1 -0", tier: "major" });
  assert.match(completion, /completion gate/);
  assert.match(completion, /\+1 -0/);
  assert.match(completion, /"stage" echoed|completion|"verdict"/);
});

test("prompt truncation keeps heads and tails", () => {
  const big = "A".repeat(100000);
  const follow = buildFollowGatePrompt({ plan: big, segment: "x", budgetMs: 1000 });
  assert.ok(follow.length < 100000);
  assert.match(follow, /truncated/);
});
