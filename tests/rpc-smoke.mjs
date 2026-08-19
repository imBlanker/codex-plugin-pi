#!/usr/bin/env node
/* Local verification harness: drive the extension via pi RPC mode. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "extensions", "index.ts");

const proc = spawn("pi", ["--mode", "rpc", "--no-session", "-e", EXT], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "inherit"]
});

const seen = [];
let buf = "";
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  while (true) {
    const idx = buf.indexOf("\n");
    if (idx === -1) break;
    let line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      seen.push(JSON.parse(line));
    } catch {
      /* ignore non-JSON */
    }
  }
});

function send(cmd) {
  proc.stdin.write(JSON.stringify(cmd) + "\n");
}

function waitFor(predicate, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = seen.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout waiting for predicate; events: " + JSON.stringify(seen.slice(-8))));
      }
    }, 100);
  });
}

async function main() {
  send({ id: "c1", type: "get_commands" });
  const cmdResp = await waitFor((e) => e.type === "response" && e.id === "c1");
  const names = cmdResp.data.commands.filter((c) => c.source === "extension").map((c) => c.name);
  console.log("extension commands:", names.join(", "));
  const expected = ["codex-setup", "codex-review", "codex-adversarial-review", "codex-rescue", "codex-transfer", "codex-status", "codex-result", "codex-cancel"];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    throw new Error("missing commands: " + missing.join(", "));
  }

  send({ id: "p1", type: "prompt", message: "/codex-status" });
  await waitFor((e) => e.type === "response" && e.id === "p1");
  // the command posts a custom message with the status output
  const entry = await waitFor(
    (e) => e.type === "message_end" && e.message?.customType === "codex-status",
    90000
  );
  console.log("status command executed:", entry.message.content.split("\n")[0]);
  proc.kill();
  console.log("VERIFY OK");
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err.message);
  proc.kill();
  process.exit(1);
});
