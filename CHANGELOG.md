# Changelog

## 0.2.1 (2026-08-21)

- **Fix: `codex_review` crashed the pi TUI when the companion wrote to stderr**
  (issue #3). The streaming callback emitted `onUpdate({ text })`, which is
  not a partial `ToolResult`; pi 0.84.2's renderer guards `result` but not
  `result.content` (`render-utils.js` `result.content.filter` on `undefined`)
  → uncaught `TypeError` → TUI exit mid-review, losing the result. Now emits
  `onUpdate({ content: [{ type: "text", text: line }] })` — the same shape
  the plugin's own gate handler reads (`partialResult?.content`). Side
  benefit: stderr progress lines now actually render in the tool result card
  (the renderer only ever looked at `content`). Source-contract regression
  test added (`tests/partial-update.test.mjs`). (pi-side renderer hardening
  belongs upstream: badlogic/pi-mono.)

## 0.2.0 (2026-08-20) — full-lifecycle review gate (family lockstep)

- Gate family core vendored to `lib/gate/` (byte-identical with
  codex-plugin-cc fork & codex-plugin-dsh): verdict contract, budget tiers
  15m/10m/1m/30s, AA-seeded effort picker, OS-global learner, fail-open
  timeouts.
- Companion: `gate plan|follow|completion|learner|status|on|off`.
- Extension: `/codex-gate` command; Stage-2 realtime follow via
  `tool_execution_update` (batched ≥2KB/5s) with abort+steer on FAIL;
  Stage-3 commit-block via `tool_call` until fresh completion PASS.
- `runAppServerTurn({disableBroker})` — no lazy-broker leaks.
- Tests 91 (73 + 18 gate). Learner store shared cross-host.

## 0.1.0 (2026-08-19)

Initial port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(v1.0.6, commit db52e28) to the Pi coding agent.

- Vendored companion core (`lib/`) with host seams: Pi client identity,
  XDG state root, Pi transcript roots for transfer, companion path resolution.
- Pi extension: 8 commands (`/codex-setup`, `/codex-review`,
  `/codex-adversarial-review`, `/codex-rescue`, `/codex-transfer`,
  `/codex-status`, `/codex-result`, `/codex-cancel`) and 5 model-invocable
  tools (`codex_review`, `codex_delegate`, `codex_job_*`).
- Background job poller with session-scoped job tracking and idle-safe
  result delivery.
- Ported test suite (73 tests; CC-hook tests skipped by design) + RPC smoke
  harness.
- PR CI, bump-version script, Apache-2.0 + attribution (NOTICE, PORTING.md).
