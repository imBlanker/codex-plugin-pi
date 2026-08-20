/**
 * gate-learner.mjs — OS-global latency learner shared by ALL hosts.
 *
 * Store: $CODEX_REVIEW_LEARNER_DIR || $XDG_STATE_HOME/codex-review-learner
 *        || ~/.local/state/codex-review-learner/learner.json
 * Every host plugin (cc fork, pi, dsh) reads and writes the SAME file, so
 * what one host learns about (objclass, model, effort) latencies, every
 * host uses. Price data is deliberately NOT tracked (price-gate exempt).
 *
 * Family-core file, identical across codex-plugin-cc/-pi/-dsh.
 * New code: Copyright 2026 imBlanker (Apache-2.0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { EFFORTS, seedExpectedMs } from "./gate-budget.mjs";

export const LEARNER_VERSION = 1;
export const BURN_IN = 5; // samples before learned mean beats the seed
const EMA_ALPHA = 0.3;
const LOCK_STALE_MS = 10_000;

function storeDir(options = {}) {
  if (options.dir) return options.dir;
  if (process.env.CODEX_REVIEW_LEARNER_DIR) return process.env.CODEX_REVIEW_LEARNER_DIR;
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "codex-review-learner");
}

function storeFile(options = {}) {
  return path.join(storeDir(options), "learner.json");
}

export function emptyState() {
  return { version: LEARNER_VERSION, samples: {}, lastUpdated: null, hostHistory: [] };
}

export function loadState(options = {}) {
  const file = storeFile(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === LEARNER_VERSION && parsed.samples && typeof parsed.samples === "object") {
      return parsed;
    }
    throw new Error("version mismatch");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    // corruption: preserve a backup, start fresh (design D5)
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return emptyState();
  }
}

/** Welford update + EMA on one observed latency for a key. */
export function recordSample(state, key, ms, host = null) {
  const s = state.samples[key] ?? { n: 0, mean_ms: 0, m2: 0, last_ms: null, ema_ms: null };
  const x = Math.max(0, Math.round(ms));
  s.n += 1;
  if (s.n === 1) {
    s.mean_ms = x;
    s.m2 = 0;
    s.ema_ms = x;
  } else {
    const delta = x - s.mean_ms;
    s.mean_ms += delta / s.n;
    s.m2 += delta * (x - s.mean_ms);
    s.ema_ms = s.ema_ms == null ? x : s.ema_ms + EMA_ALPHA * (x - s.ema_ms);
  }
  s.last_ms = x;
  state.samples[key] = s;
  state.lastUpdated = new Date().toISOString();
  if (host) {
    state.hostHistory.push({ host, ts: state.lastUpdated });
    if (state.hostHistory.length > 200) state.hostHistory.splice(0, state.hostHistory.length - 200);
  }
  return state;
}

/** Learned expected-ms for (objclass, model, effort); null before burn-in. */
export function learnedExpectedMs(state, objclass, model, effort) {
  const s = state.samples[`${objclass}|${model}|${effort}`];
  if (!s || s.n < BURN_IN) return null;
  // EMA reacts to sustained drift (network, provider load); fall back to mean.
  return Math.round(s.ema_ms ?? s.mean_ms);
}

/**
 * Choose (effort, source) for an objclass given a budget and model set.
 * Delegates the effort ladder to the caller's picker for consistency:
 * here we only bridge learner data into gate-budget.pickEffort semantics.
 */
export function chooseEffort(state, objclass, budgetMs, models, pickEffortFn) {
  // Allowed set: prefer the default model first (models[0]).
  const model = models?.[0] ?? "*";
  const learned = (effort) => learnedExpectedMs(state, objclass, model, effort);
  return pickEffortFn(model, budgetMs, { learnedExpectedMs: learned, efforts: EFFORTS });
}

/* ------------------------- persistence + locking ------------------------ */

function lockPath(options = {}) {
  return `${storeFile(options)}.lock`;
}

function acquireLock(options = {}) {
  const lock = lockPath(options);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
  } catch {
    /* no lock file */
  }
  const fd = fs.openSync(lock, "wx"); // throws if held
  return fd;
}

function releaseLock(options = {}) {
  fs.rmSync(lockPath(options), { force: true });
}

export function saveState(state, options = {}) {
  const dir = storeDir(options);
  fs.mkdirSync(dir, { recursive: true });
  const file = storeFile(options);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file); // atomic on POSIX
}

/** Record one observation durably (lock → mutate → atomic write → unlock). */
export function recordAndSave(key, ms, host, options = {}) {
  let fd;
  try {
    fd = acquireLock(options);
    const state = loadState(options);
    recordSample(state, key, ms, host);
    saveState(state, options);
    return state;
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    releaseLock(options);
  }
}

/** Reset the store (keeps a timestamped backup). */
export function resetStore(options = {}) {
  const file = storeFile(options);
  try {
    fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to reset */
  }
  return emptyState();
}

/** Compact human status for `gate learner status`. */
export function renderStatus(state) {
  const keys = Object.keys(state.samples);
  const lines = [`learner store v${LEARNER_VERSION}: ${keys.length} key(s), burn-in=${BURN_IN}`];
  for (const key of keys.slice(0, 40)) {
    const s = state.samples[key];
    lines.push(
      `  ${key}: n=${s.n} mean=${Math.round(s.mean_ms)}ms ema=${s.ema_ms == null ? "-" : Math.round(s.ema_ms) + "ms"} last=${s.last_ms == null ? "-" : s.last_ms + "ms"}`
    );
  }
  if (state.hostHistory.length > 0) {
    const hosts = [...new Set(state.hostHistory.map((h) => h.host))];
    lines.push(`hosts seen: ${hosts.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
