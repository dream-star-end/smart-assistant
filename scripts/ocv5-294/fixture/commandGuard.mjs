#!/usr/bin/env node
/** Exact-command PreToolUse guard. Default deny. Allowed commands are
 * forwarded unchanged to the real efficiencyHookRunner. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const allowlistPath = process.env.OCV5_294_ALLOWLIST ?? join(here, "allowlist.json");
const runner = process.env.OCV5_294_EFFICIENCY_RUNNER
  ?? "/opt/openclaude/packages/gateway/dist/efficiencyHookRunner.cjs";
if (!allowlistPath || !runner) {
  deny("guard is not configured");
}

const allow = JSON.parse(readFileSync(allowlistPath, "utf8"));
const echo = allow.echo;
const sed = allow.sed;
if (typeof echo !== "string" || typeof sed !== "string" || echo === sed) {
  deny("allowlist is not two distinct exact commands");
}

const raw = await readStdin();
let body;
try { body = JSON.parse(raw); }
catch { deny("hook input is not json"); }
const tool = typeof body.tool_name === "string" ? body.tool_name : "";
const command = body.tool_input && typeof body.tool_input.command === "string"
  ? body.tool_input.command : "";
if (tool !== "Bash" || (command !== echo && command !== sed)) {
  deny("command is not the fixed echo or fixed sed fixture");
}

const child = spawn(process.execPath, [runner, "--protocol=ccb", "--mode=warn"], {
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.end(raw);
const out = [];
child.stdout.on("data", (chunk) => out.push(chunk));
const timer = setTimeout(() => child.kill("SIGTERM"), 4000);
const code = await new Promise((resolve) => child.once("close", resolve));
clearTimeout(timer);
if (code !== 0) deny(`efficiency runner exit ${code}`);
process.stdout.write(Buffer.concat(out));

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}
