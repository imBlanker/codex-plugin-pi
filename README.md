# codex-plugin-pi

Use [Codex](https://developers.openai.com/codex/) from inside the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
for code reviews or to delegate tasks.

This plugin is for Pi users who want an easy way to start using Codex from
the workflow they already have. It is a port of OpenAI's official
[codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Claude Code)
to Pi's extension model.

> Status: v0.1.x — early port. See CHANGELOG.md.

## What You Get

- `/codex-setup` for a readiness check of the Codex CLI (and an optional
  one-command npm install offer)
- `/codex-review` for a read-only Codex review of your git state
- `/codex-adversarial-review` for a steerable, skeptical challenge review
- `/codex-rescue` to delegate stuck or heavy work to Codex
- `/codex-transfer` to hand the current Pi session context to Codex
  (experimental)
- `/codex-status`, `/codex-result`, `/codex-cancel` to manage background
  jobs
- Model-invocable tools (`codex_review`, `codex_delegate`, `codex_*` job
  tools) so the agent itself can use Codex mid-conversation

## Install

Requires Node.js ≥ 18.18 and the `pi` CLI. Then:

```bash
pi install npm:codex-plugin-pi
# or from git:
pi install git:github.com/imBlanker/codex-plugin-pi
```

Restart Pi (or `/reload`). The commands above become available, and the
tools are registered for the model.

Then run:

```
/codex-setup
```

## Usage

### `/codex-setup`
Checks whether the local Codex CLI is ready (binary present, auth state).
If Codex is missing and npm is available, it offers to install
`@openai/codex` for you.

### `/codex-review [--wait|--background] [--base <ref>]`
Runs a Codex review against local git state. By default you are asked
whether to wait or run in the background; background jobs are visible via
`/codex-status`.

### `/codex-adversarial-review [focus text]`
A more skeptical review pass: Codex is prompted to break confidence in the
change rather than validate it. Pass optional focus text.

### `/codex-rescue [task description]`
Delegates a task to Codex's task runtime (`--resume` continuity, model and
effort flags supported through the companion CLI). Runs as a background
job by default.

### `/codex-status`, `/codex-result`, `/codex-cancel`
Job management. `/codex-result` injects the finished job's output into the
conversation.

### `/codex-transfer` (experimental)
Hands the current Pi session transcript to Codex as a thread you can
continue with `codex resume`.

## Codex Integration

The plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server)
via the global `codex` binary and applies your existing Codex
[configuration](https://developers.openai.com/codex/config-basic). Sign in
with `codex login` (ChatGPT account or API key) if you have not yet.

## License & Attribution

Apache-2.0. Derived from openai/codex-plugin-cc © 2026 OpenAI; see NOTICE.
New code © 2026 imBlanker.
