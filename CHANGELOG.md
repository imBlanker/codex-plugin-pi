# Changelog

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
