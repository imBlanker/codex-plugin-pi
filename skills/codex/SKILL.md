---
name: codex
description: Guidance for the codex-plugin-pi runtime — how to invoke the Codex companion tools and present their output
---

# Codex Companion (Pi port)

When the user asks for a Codex review, a second implementation pass, or
delegation of heavy work to Codex, use the registered tools:

- `codex_review` — read-only Codex review of local git state. Return the
  review text verbatim; do not fix issues it mentions unless the user asks.
- `codex_delegate` — hand a substantial task to Codex as a background job.
  Compose a complete, self-contained prompt (Codex cannot see this
  conversation). Report the job id, then poll `codex_job_status` and fetch
  with `codex_job_result` when the user asks.
- `codex_job_status` / `codex_job_result` / `codex_job_cancel` — job
  management (JSON output).

Prefer the `/codex-*` commands for interactive use; prefer the tools when
acting on the user's behalf mid-conversation.

Present Codex output verbatim in a fenced block. Never paraphrase review
findings. If a job fails, include its error text and the log path.

Setup problems (codex missing, not logged in) → tell the user to run
`/codex-setup`.
