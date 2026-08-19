/**
 * codex-plugin-pi — Pi extension for the Codex companion runtime.
 *
 * Port of openai/codex-plugin-cc (Apache-2.0, © 2026 OpenAI) to the Pi
 * coding agent. Host integration code: Copyright 2026 imBlanker.
 *
 * Surfaces:
 * - Commands: /codex-setup /codex-review /codex-adversarial-review
 *   /codex-rescue /codex-transfer /codex-status /codex-result /codex-cancel
 * - Tools: codex_review codex_delegate codex_job_status codex_job_result
 *   codex_job_cancel
 * - Background job poller with idle-gated result delivery.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = path.join(PKG_ROOT, "lib", "codex-companion.mjs");
const SESSION_ENV = "CODEX_COMPANION_SESSION_ID";
const POLL_INTERVAL_MS = 30_000;

type Ctx = any; // ExtensionCommandContext / tool ctx — structural use only

function sessionId(ctx: Ctx): string {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (typeof file === "string" && file.length > 0) {
    return path.basename(file, ".jsonl");
  }
  return "pi-ephemeral";
}

function companionEnv(ctx: Ctx): NodeJS.ProcessEnv {
  return { ...process.env, [SESSION_ENV]: sessionId(ctx) };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCompanionSync(ctx: Ctx, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: ctx?.cwd ?? process.cwd(),
    env: companionEnv(ctx),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run the companion, capturing stdout (and streaming stderr lines to onUpdate). */
async function runCompanionAsync(
  ctx: Ctx,
  args: string[],
  onUpdate?: (text: string) => void
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], {
      cwd: ctx?.cwd ?? process.cwd(),
      env: companionEnv(ctx)
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    const rlErr = createInterface({ input: child.stderr });
    rlErr.on("line", (line: string) => {
      stderr += line + "\n";
      onUpdate?.(line);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Spawn a detached companion run (host-side background, like CC run_in_background). */
function runCompanionDetached(ctx: Ctx, args: string[], logFile: string) {
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(process.execPath, [COMPANION, ...args], {
    cwd: ctx?.cwd ?? process.cwd(),
    env: companionEnv(ctx),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.unref();
  return child;
}

function backgroundLogPath(ctx: Ctx, name: string): string {
  const dir = path.join(os.tmpdir(), "codex-plugin-pi");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${name}-${stamp}.log`);
}

/** Record + display a multi-line result in the transcript (no model turn). */
function displayMessage(pi: ExtensionAPI, customType: string, text: string) {
  try {
    pi.sendMessage({ customType, content: text, display: true });
  } catch {
    /* non-fatal */
  }
}

function notify(ctx: Ctx, text: string, level: "info" | "warning" | "error" = "info") {
  if (ctx?.hasUI) {
    try {
      ctx.ui.notify(text, level);
      return;
    } catch {
      /* fall through */
    }
  }
  console.error(text);
}

function estimateReviewSize(ctx: Ctx): "tiny" | "large" {
  try {
    const cwd = ctx?.cwd ?? process.cwd();
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd, encoding: "utf8" });
    const staged = spawnSync("git", ["diff", "--shortstat", "--cached"], { cwd, encoding: "utf8" });
    const unstaged = spawnSync("git", ["diff", "--shortstat"], { cwd, encoding: "utf8" });
    const statusLines = (status.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
    const files = statusLines.length;
    const stat = (s: string) => {
      const m = (s ?? "").match(/(\d+) files? changed/);
      return m ? Number(m[1]) : 0;
    };
    const diffFiles = stat(staged.stdout ?? "") + stat(unstaged.stdout ?? "");
    const total = Math.max(files, diffFiles);
    return total <= 2 ? "tiny" : "large";
  } catch {
    return "large";
  }
}

function splitFlags(rawArgs: string): string[] {
  const trimmed = rawArgs.trim();
  if (!trimmed) return [];
  // conservative shell-like split: respects double quotes
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of trimmed) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function renderSetupSummary(payload: any): string {
  const lines: string[] = ["Codex Companion setup"];
  lines.push(`  node: ${payload?.node?.available ? "OK" : "MISSING"} ${payload?.node?.detail ?? ""}`.trimEnd());
  lines.push(`  npm:  ${payload?.npm?.available ? "OK" : "MISSING"} ${payload?.npm?.detail ?? ""}`.trimEnd());
  lines.push(`  codex:${payload?.codex?.available ? " OK " : " MISSING"} ${payload?.codex?.detail ?? ""}`.trimEnd());
  const auth = payload?.auth;
  lines.push(
    `  auth: ${auth?.available ? (auth.loggedIn ? "logged in" : "not logged in") : "unknown"}${auth?.detail ? ` — ${auth.detail}` : ""}`
  );
  lines.push(`  ready: ${payload?.ready ? "YES" : "NO"}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Review flow (shared by command + tool)                              */
/* ------------------------------------------------------------------ */

async function decideAndWait(
  pi: ExtensionAPI,
  ctx: Ctx,
  rawArgs: string
): Promise<"wait" | "background"> {
  const args = splitFlags(rawArgs);
  if (args.includes("--wait")) return "wait";
  if (args.includes("--background")) return "background";
  const size = estimateReviewSize(ctx);
  const recommend = size === "tiny" ? "wait" : "background";
  if (!ctx?.hasUI) return recommend;
  try {
    const choice = await ctx.ui.select(
      "Run the Codex review…",
      [`Wait for results (${recommend === "wait" ? "Recommended)" : ""}`.trim(), `Run in background (${recommend === "background" ? "Recommended)" : ""}`.trim()]
    );
    if (choice === undefined) return recommend;
    return choice.startsWith("Wait") ? "wait" : "background";
  } catch {
    return recommend;
  }
}

async function runReview(
  pi: ExtensionAPI,
  ctx: Ctx,
  subcommand: "review" | "adversarial-review",
  rawArgs: string,
  forcedMode?: "wait" | "background"
): Promise<string> {
  const args = [subcommand, ...splitFlags(rawArgs)];
  const mode = forcedMode ?? (await decideAndWait(pi, ctx, rawArgs));
  if (mode === "wait") {
    const r = await runCompanionAsync(ctx, args);
    const text = r.stdout.trim() || r.stderr.trim() || "(no output)";
    displayMessage(pi, "codex-review-result", text);
    return text;
  }
  const log = backgroundLogPath(ctx, subcommand);
  runCompanionDetached(ctx, args, log);
  const msg = `Codex ${subcommand} started in the background.\nLog: ${log}\nCheck /codex-status for progress.`;
  notify(ctx, `Codex ${subcommand} running in background`, "info");
  displayMessage(pi, "codex-review-started", msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* Extension factory                                                   */
/* ------------------------------------------------------------------ */

export default function codexPluginPi(pi: ExtensionAPI) {
  let pollTimer: NodeJS.Timeout | null = null;
  const lastSeen = new Map<string, string>();

  /* ---- commands ---- */

  pi.registerCommand("codex-setup", {
    description: "Check Codex CLI readiness (optionally install it)",
    handler: async (_args: string, ctx: Ctx) => {
      let r = runCompanionSync(ctx, ["setup", "--json"]);
      let payload: any = null;
      try {
        payload = JSON.parse(r.stdout);
      } catch {
        /* keep null */
      }
      if (!payload) {
        notify(ctx, r.stdout.trim() || r.stderr.trim() || "setup failed", "error");
        return;
      }
      if (!payload.codex?.available && payload.npm?.available && ctx?.hasUI) {
        let install = true;
        try {
          install = await ctx.ui.confirm(
            "Install Codex? (Recommended)",
            "Codex CLI is missing. Install @openai/codex globally via npm?"
          );
        } catch {
          install = false;
        }
        if (install) {
          notify(ctx, "Installing @openai/codex (npm install -g)…", "info");
          const npm = spawnSync("npm", ["install", "-g", "@openai/codex"], { encoding: "utf8" });
          if (npm.status !== 0) {
            notify(ctx, "npm install failed — install Codex manually: npm install -g @openai/codex", "error");
          }
          r = runCompanionSync(ctx, ["setup", "--json"]);
          try {
            payload = JSON.parse(r.stdout);
          } catch {
            /* keep old */
          }
        }
      }
      const summary = payload ? renderSetupSummary(payload) : r.stdout;
      displayMessage(pi, "codex-setup", summary);
      if (!payload?.ready) {
        notify(ctx, "Codex not ready — see /codex-setup report", "warning");
      }
    }
  });

  pi.registerCommand("codex-review", {
    description: "Run a Codex review against local git state",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["--wait", "--background", "--base", "--scope working-tree", "--scope branch"];
      const hits = opts.filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o }));
      return hits.length > 0 ? hits : null;
    },
    handler: async (args: string, ctx: Ctx) => {
      await runReview(pi, ctx, "review", args ?? "");
    }
  });

  pi.registerCommand("codex-adversarial-review", {
    description: "Run a skeptical Codex challenge review (optional focus text)",
    handler: async (args: string, ctx: Ctx) => {
      await runReview(pi, ctx, "adversarial-review", args ?? "");
    }
  });

  pi.registerCommand("codex-rescue", {
    description: "Delegate a task to Codex (background job)",
    handler: async (args: string, ctx: Ctx) => {
      let prompt = (args ?? "").trim();
      if (!prompt && ctx?.hasUI) {
        try {
          prompt = (await ctx.ui.input("Task for Codex:", "Describe the task to delegate")) ?? "";
        } catch {
          prompt = "";
        }
      }
      if (!prompt) {
        notify(ctx, "Usage: /codex-rescue <task description>", "warning");
        return;
      }
      const r = await runCompanionAsync(ctx, ["task", "--background", prompt]);
      const text = r.stdout.trim() || r.stderr.trim() || "(no output)";
      displayMessage(pi, "codex-rescue", text);
    }
  });

  pi.registerCommand("codex-transfer", {
    description: "Hand the current Pi session to Codex (experimental)",
    handler: async (_args: string, ctx: Ctx) => {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (!file) {
        notify(ctx, "No persisted Pi session to transfer.", "warning");
        return;
      }
      const r = await runCompanionAsync(ctx, ["transfer", "--source", file]);
      const text = r.stdout.trim() || r.stderr.trim() || "(no output)";
      displayMessage(pi, "codex-transfer", `${text}\n(experimental — Codex imports Claude-format transcripts; a Pi transcript may fail to parse)`);
    }
  });

  const jobCommand = (
    name: string,
    subcommand: string,
    description: string
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args: string, ctx: Ctx) => {
        const r = runCompanionSync(ctx, [subcommand, ...splitFlags(args ?? "")]);
        const text = r.stdout.trim() || r.stderr.trim() || "(no output)";
        if (subcommand === "result") {
          displayMessage(pi, "codex-result", text);
        } else {
          displayMessage(pi, `codex-${subcommand}`, text);
        }
      }
    });
  };
  jobCommand("codex-status", "status", "List Codex companion jobs");
  jobCommand("codex-result", "result", "Fetch a Codex job result");
  jobCommand("codex-cancel", "cancel", "Cancel a Codex job");

  /* ---- model-invocable tools ---- */

  pi.registerTool({
    name: "codex_review",
    label: "Codex review",
    description:
      "Run a read-only Codex code review against the current git state. Returns the review verbatim. Do not fix issues; report them.",
    promptSnippet:
      "Use codex_review for an independent second-opinion review of local changes.",
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: "Base ref for branch-scope review" })),
      scope: Type.Optional(Type.String({ description: "auto | working-tree | branch" }))
    }),
    async execute(_id: string, params: any, _signal: AbortSignal, onUpdate: (u: any) => void) {
      const args = ["review"];
      if (params?.base) args.push("--base", String(params.base));
      if (params?.scope) args.push("--scope", String(params.scope));
      const r = await runCompanionAsync({ cwd: process.cwd() }, args, (line) =>
        onUpdate({ text: line })
      );
      return {
        content: [{ type: "text", text: r.stdout.trim() || r.stderr.trim() || "(no output)" }],
        details: { exitCode: r.code }
      };
    }
  });

  pi.registerTool({
    name: "codex_delegate",
    label: "Codex delegate",
    description:
      "Delegate a substantial coding/debugging task to Codex as a background job. Returns the job id; poll with codex_job_status, fetch with codex_job_result.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Complete task description for Codex" }),
      write: Type.Optional(Type.Boolean({ description: "Allow Codex to write changes" }))
    }),
    async execute(_id: string, params: any) {
      const args = ["task", "--background"];
      if (params?.write) args.push("--write");
      args.push(String(params.prompt));
      const r = await runCompanionAsync({ cwd: process.cwd() }, args);
      return {
        content: [{ type: "text", text: r.stdout.trim() || r.stderr.trim() || "(no output)" }],
        details: {}
      };
    }
  });

  const jsonJobTool = (
    name: string,
    subcommand: string,
    description: string,
    argName: string
  ) => {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: Type.Object({
        jobId: Type.Optional(Type.String({ description: `${argName} (defaults to latest in session)` }))
      }),
      async execute(_id: string, params: any) {
        const args = [subcommand, "--json"];
        if (params?.jobId) args.push(String(params.jobId));
        const r = runCompanionSync({ cwd: process.cwd() }, args);
        return {
          content: [{ type: "text", text: r.stdout.trim() || r.stderr.trim() || "{}" }],
          details: {}
        };
      }
    });
  };
  jsonJobTool("codex_job_status", "status", "Codex job status (JSON)", "job id");
  jsonJobTool("codex_job_result", "result", "Codex job result (JSON)", "job id");
  jsonJobTool("codex_job_cancel", "cancel", "Cancel a Codex job (JSON)", "job id");

  /* ---- background completion poller ---- */

  async function pollJobs(ctx: Ctx) {
    let payload: any = null;
    try {
      const r = runCompanionSync(ctx, ["status", "--all", "--json"]);
      payload = JSON.parse(r.stdout);
    } catch {
      return;
    }
    const jobs: any[] = Array.isArray(payload?.jobs) ? payload.jobs : [];
    for (const job of jobs) {
      const id = String(job?.id ?? "");
      const status = String(job?.status ?? "");
      if (!id) continue;
      const prev = lastSeen.get(id);
      const finished =
        status === "completed" || status === "failed" || status === "cancelled";
      if (prev && prev !== status && finished) {
        let text = `Codex job ${id} ${status}.`;
        try {
          const rr = runCompanionSync(ctx, ["result", id]);
          text = rr.stdout.trim() || text;
        } catch {
          /* keep short text */
        }
        try {
          pi.sendMessage(
            { customType: "codex-job-finished", content: text, display: true },
            { deliverAs: "followUp", triggerTurn: false }
          );
        } catch {
          /* non-fatal */
        }
        notify(ctx, `Codex job ${id} ${status}`, status === "completed" ? "info" : "warning");
      }
      lastSeen.set(id, status);
    }
  }

  pi.on("session_start", async (_event: any, ctx: Ctx) => {
    // seed the seen-map so pre-existing finished jobs don't re-announce
    try {
      const r = runCompanionSync(ctx, ["status", "--all", "--json"]);
      const payload = JSON.parse(r.stdout);
      for (const job of payload?.jobs ?? []) {
        if (job?.id) lastSeen.set(String(job.id), String(job.status ?? ""));
      }
    } catch {
      /* no state yet */
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      pollJobs(ctx).catch(() => {});
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}
