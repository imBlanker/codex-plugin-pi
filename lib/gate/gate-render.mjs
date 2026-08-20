/**
 * gate-render.mjs — human rendering of gate verdict envelopes.
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */

export function renderVerdict(envelope) {
  if (!envelope || typeof envelope !== "object") return "# Gate: (no verdict)\n";
  const icon = envelope.verdict === "pass" ? "✅" : "⛔";
  const lines = [
    `# Codex Gate — ${envelope.stage ?? "?"}: ${envelope.verdict.toUpperCase()} ${icon}`,
    `model: ${envelope.model ?? "?"} · effort: ${envelope.effort_used ?? "?"}` +
      ` (${envelope.effort_source ?? "n/a"}) · elapsed: ${envelope.elapsed_ms ?? "?"}ms / budget ${envelope.budget_ms ?? "?"}ms` +
      (envelope.timed_out ? " · TIMED OUT (fail-open)" : "")
  ];
  if (envelope.reasons?.length) {
    lines.push("", "Reasons:");
    for (const reason of envelope.reasons) lines.push(`- ${reason}`);
  }
  if (envelope.deviation_summary) {
    lines.push("", `Deviation: ${envelope.deviation_summary}`);
  }
  if (envelope.recommendation) {
    lines.push("", `Recommendation: ${envelope.recommendation}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderGateStatus(status) {
  const lines = ["# Codex Gate status"];
  lines.push(`enabled: ${status.enabled ? "yes" : "no"}`);
  if (status.task) {
    lines.push(`stage: ${status.task.stage} · task: ${short(status.task.label)}`);
  }
  if (status.tier) lines.push(`tier: ${status.tier}`);
  if (typeof statsOf(status) === "string") lines.push(statsOf(status));
  return `${lines.join("\n")}\n`;
}

function statsOf(status) {
  return status.stats ?? null;
}

function short(text) {
  const s = String(text ?? "");
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
