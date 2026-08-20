/**
 * gate-prompt.mjs — per-stage Codex prompt builders for the review gate.
 *
 * Every prompt demands EXACTLY ONE JSON verdict envelope (see
 * gate-verdict.mjs) and nothing else. Prompts follow the upstream
 * adversarial-review block style (role/task/contract) adapted for gating.
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */

const CONTRACT = `<output_contract>
Respond with EXACTLY ONE JSON object and nothing else — no prose, no fences:
{
  "verdict": "pass" | "fail",
  "stage": "<stage value echoed from this prompt>",
  "confidence": 0.0-1.0,
  "reasons": ["short, concrete reasons"],
  "deviation_summary": "only when verdict=fail: what deviates and why it matters",
  "recommendation": "proceed" | "revise-plan" | "halt-chain" | "continue-fixing"
}
</output_contract>`;

export function buildPlanGatePrompt({ plan, tier, context }) {
  return [
    "<role>You are Codex operating a plan-approval gate before any execution starts.</role>",
    `<task>Review the agent's plan for the upcoming task. Decide whether execution may start. Plan tier: ${tier}.</task>`,
    context ? `<workspace_context>${truncate(context, 4000)}</workspace_context>` : "",
    "<plan>",
    truncate(plan, 60000),
    "</plan>",
    `<operating_stance>
- Judge executability and safety: clear goal, steps coherent and sufficient, right files/tools, risks addressed, rollback possible.
- FAIL when the plan is vague, self-contradictory, touches the wrong surface, invites destructive/irreversible actions, or skips verification FOR RISKY steps.
- Scale-aware: judge a plan against its own risk. A trivial one-step action (create/edit a file, run a safe command) does NOT need an explicit verification step to pass; demanding ceremony proportional to risk, never more.
- Do NOT grade style or ambition. A workable ugly plan passes; a beautiful broken one fails.
</operating_stance>`,
    CONTRACT.replace("<stage value echoed from this prompt>", "plan"),
    ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFollowGatePrompt({ plan, segment, opSummary, budgetMs }) {
  return [
    "<role>You are Codex operating a realtime output gate DURING execution.</role>",
    `<task>Compare the latest command/operation output segment against the approved plan. Detect major deviation fast. You have ~${Math.round(budgetMs / 1000)}s wall-clock; be decisive, not exhaustive.</task>`,
    "<approved_plan>",
    truncate(plan, 12000),
    "</approved_plan>",
    opSummary ? `<operation>${truncate(opSummary, 1000)}</operation>` : "",
    "<output_segment>",
    truncate(segment, 20000),
    "</output_segment>",
    `<operating_stance>
- PASS when output is consistent with the plan, or the deviation is minor/self-correcting.
- FAIL (recommendation halt-chain) ONLY for major deviation: wrong direction, destructive side effects, error storms contradicting the plan, or evidence the plan's assumptions are void.
- Latency-sensitive: prefer pass-with-low-confidence over slow deliberation; a wrong fail halts productive work.
</operating_stance>`,
    CONTRACT.replace("<stage value echoed from this prompt>", "follow"),
    ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCompletionGatePrompt({ plan, summary, diff, tier }) {
  return [
    "<role>You are Codex operating the completion gate before work is declared done and committed.</role>",
    `<task>Verify overall completion: result vs approved plan. Completion tier: ${tier}.</task>`,
    "<approved_plan>",
    truncate(plan, 30000),
    "</approved_plan>",
    summary ? `<completion_summary>${truncate(summary, 8000)}</completion_summary>` : "",
    diff ? "<final_diff>\n" + truncate(diff, 80000) + "\n</final_diff>" : "",
    `<operating_stance>
- PASS only when the plan's stated deliverables exist in the diff/summary, checks plausibly ran, and nothing unexplained crept in.
- FAIL (continue-fixing) when deliverables are missing, the diff contradicts the plan, or obvious regressions/loose ends remain.
- Judge completion, not perfection: follow-up work explicitly out of the plan does not block PASS.
</operating_stance>`,
    CONTRACT.replace("<stage value echoed from this prompt>", "completion"),
    ""
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.floor(max / 2))}\n…[truncated ${s.length - max} chars]…\n${s.slice(-Math.floor(max / 2))}`;
}
