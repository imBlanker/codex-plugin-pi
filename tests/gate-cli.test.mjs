import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "lib", "codex-companion.mjs");

function gateEnv(extra = {}) {
  return { ...process.env, ...extra };
}

test("gate learner status|reset round-trips an isolated store", () => {
  const learnerDir = makeTempDir();
  const env = gateEnv({ CODEX_REVIEW_LEARNER_DIR: learnerDir });

  const empty = run("node", [SCRIPT, "gate", "learner", "status"], { env });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 key\(s\)/);

  const state = { version: 1, samples: { "plan-other|default|low": { n: 9, mean_ms: 5000, m2: 0, last_ms: 5000, ema_ms: 5000 } }, lastUpdated: "2026-08-20T00:00:00.000Z", hostHistory: [{ host: "test", ts: "2026-08-20T00:00:00.000Z" }] };
  fs.writeFileSync(path.join(learnerDir, "learner.json"), JSON.stringify(state));

  const shown = run("node", [SCRIPT, "gate", "learner", "status"], { env });
  assert.match(shown.stdout, /plan-other\|default\|low: n=9/);

  const reset = run("node", [SCRIPT, "gate", "learner", "reset"], { env });
  assert.equal(reset.status, 0, reset.stderr);
  assert.ok(fs.readdirSync(learnerDir).some((f) => f.includes("backup-")), "reset keeps a backup");
  const after = run("node", [SCRIPT, "gate", "learner", "status"], { env });
  assert.match(after.stdout, /0 key\(s\)/);
});

test("gate plan with fake codex non-JSON answer degrades to malformed-failopen pass", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "gate", "plan", "--json", "--cwd", repo, "--tier", "other", "--effort", "low", "--no-learn", "do a tiny thing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr); // fail-open pass → exit 0
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verdict, "pass");
  assert.equal(payload.source, "malformed-failopen");
  assert.equal(payload.effort_used, "low"); // override honored
  assert.equal(payload.stage, "plan");
  assert.ok(Array.isArray(payload.reasons) && payload.reasons.length > 0);
});

test("gate follow with 1ms budget degrades to timeout-failopen pass", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "gate", "follow", "--json", "--cwd", repo, "--budget-ms", "1", "--plan-file", "/dev/null", "--segment-text", "building…", "--no-learn"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verdict, "pass");
  assert.equal(payload.timed_out, true);
  assert.equal(payload.source, "timeout-failopen");
  assert.equal(payload.stage, "follow");
  assert.ok(payload.budget_ms <= 1 || payload.budget_ms === 1);
});

test("gate fail-closed turns timeout into fail with halt-chain", () => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "gate", "follow", "--json", "--cwd", repo, "--budget-ms", "1", "--fail-closed", "--plan-file", "/dev/null", "--segment-text", "x", "--no-learn"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verdict, "fail");
  assert.equal(payload.source, "timeout");
  assert.equal(payload.recommendation, "halt-chain");
  assert.notEqual(result.status, 0); // fail → exit 2
});

test("gate usage prints without codex", () => {
  const result = run("node", [SCRIPT, "gate"], {});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /gate plan/);
  assert.match(result.stdout, /gate learner status/);
});
