# PORTING.md — upstream sync & host seams

This repo is a port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(Claude Code plugin) to the Pi coding agent. The host-agnostic core is
**vendored** from upstream and kept as close to verbatim as possible; all
host-specific behavior is funneled through `lib/host-seams.mjs`.

## Vendored files

Source: `<cc-mirror>/plugins/codex/scripts/` → this repo's `lib/`:

| Upstream | Here | Notes |
|---|---|---|
| `codex-companion.mjs` | `lib/codex-companion.mjs` | CLI entrypoint; ROOT_DIR resolves via `host-seams` |
| `app-server-broker.mjs` | `lib/app-server-broker.mjs` | unchanged |
| `lib/app-server.mjs` | `lib/app-server.mjs` | client info via seam |
| `lib/broker-*.mjs`, `lib/codex.mjs`, `lib/git.mjs`, `lib/job-control.mjs`, `lib/tracked-jobs.mjs`, `lib/state.mjs`, `lib/render.mjs`, `lib/args.mjs`, `lib/fs.mjs`, `lib/process.mjs`, `lib/prompts.mjs`, `lib/workspace.mjs` | same names under `lib/` | state root + session env via seam |
| `../schemas/review-output.schema.json` | `schemas/review-output.schema.json` | unchanged |
| `../prompts/adversarial-review.md` | `prompts/adversarial-review.md` | unchanged |

Upstream commit at last sync: `db52e28` (v1.0.6, 2026-07-08).

Not vendored (Claude-Code-specific, replaced by the Pi extension):
`commands/*.md`, `agents/codex-rescue.md`, `hooks/*`, the CC skills
(`codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting` — the
first is superseded by the extension itself; result-handling guidance
lives in `skills/codex/SKILL.md`), `claude-session-transfer.mjs`
(replaced by a Pi transcript adapter inside the extension), and the CC
marketplace manifests.

## Host seams (`lib/host-seams.mjs`)

Single module every host-specific value comes from:

- `hostClientInfo()` — app-server client identity: `{ title: "Codex Plugin", name: "Pi", version }` (version from package.json)
- `stateRootDir()` — `$PI_CODEX_STATE_DIR` → `$XDG_STATE_HOME/pi-codex-companion` → `~/.local/state/pi-codex-companion`; upstream tmpdir fallback preserved for rootless environments
- `pluginRoot()` — resolves this package's root from `import.meta.url` (no `CLAUDE_PLUGIN_ROOT`)
- `SESSION_ID_ENV` + `currentSessionId()` — job-session scoping; the extension exports Pi's session id via the standard `CODEX_COMPANION_SESSION_ID` env when spawning the companion
- `log()` — optional host logger hook

Vendored files are patched **only** to import from `host-seams.mjs`
(never hard-code host values inline). `grep -r "CLAUDE_" lib/ extensions/`
must return nothing.

## Upstream sync procedure

1. `git -C <cc-mirror> fetch && git log` — review new commits.
2. Diff each vendored file: `diff <cc-mirror>/plugins/codex/scripts/<f> lib/<f>`.
3. Port changes into our copy; keep seam imports intact.
4. Record the new upstream commit hash at the top of this file.
5. `npm test` — ported suite + seams tests must stay green.
6. PR with the sync diff (one PR per upstream drop, cc-style).

## Adding host-specific behavior

Never scatter host conditionals through vendored code: extend
`host-seams.mjs`, and keep the vendored call sites one-line imports.
