#!/usr/bin/env node
/**
 * host-seams.mjs — single seam module for host-specific values.
 *
 * All host coupling in the vendored companion core routes through here.
 * See PORTING.md. New code: Copyright 2026 imBlanker (Apache-2.0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PKG_JSON = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Session scoping env (upstream contract; the extension exports it when spawning). */
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

/** App-server client identity for this host. */
export function hostClientInfo() {
  return {
    title: "Codex Plugin",
    name: "Pi",
    version: PKG_JSON.version ?? "0.0.0"
  };
}

/** Per-plugin persistent state root (replaces CLAUDE_PLUGIN_DATA). */
export function stateRootDir() {
  const override = process.env.PI_CODEX_STATE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "pi-codex-companion");
  return path.join(os.homedir(), ".local", "state", "pi-codex-companion");
}

/** This package's root (replaces CLAUDE_PLUGIN_ROOT). */
export function pluginRoot() {
  return PKG_ROOT;
}

/** Plugin version (from package.json). */
export function pluginVersion() {
  return PKG_JSON.version ?? "0.0.0";
}

/** Path to the companion CLI entrypoint (detached task workers re-exec it). */
export function companionScriptPath() {
  return path.join(PKG_ROOT, "lib", "codex-companion.mjs");
}

/** Transcript roots whose .jsonl sessions may be transferred to Codex. */
export function allowedTranscriptRoots() {
  return [
    path.join(os.homedir(), ".claude", "projects"),
    path.join(os.homedir(), ".pi", "agent", "sessions")
  ];
}

/** Current session id if the host exported one via env. */
export function currentSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}
