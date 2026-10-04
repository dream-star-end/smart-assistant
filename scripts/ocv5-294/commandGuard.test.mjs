import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const guard = join(dirname(fileURLToPath(import.meta.url)), "fixture/commandGuard.mjs");

function run(stdin, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guard], { env: { ...process.env, ...env } });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stdin.end(stdin);
    child.once("close", (code) => resolve({
      code, out: Buffer.concat(out).toString("utf8") }));
  });
}

test("unknown bash is denied and the real runner is not started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-294-guard-"));
  const allow = join(dir, "allow.json");
  const marker = join(dir, "runner-was-started");
  writeFileSync(allow, JSON.stringify({
    echo: "echo ocv5-294-echo-marker",
    sed: "sed -n '1p' /fixture",
  }));
  const fake = join(dir, "runner.cjs");
  writeFileSync(fake, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')\nconsole.log('{}')\n`);
  const result = await run(JSON.stringify({
    tool_name: "Bash", tool_input: { command: "sed -n 1p /etc/passwd" } }), {
    OCV5_294_ALLOWLIST: allow, OCV5_294_EFFICIENCY_RUNNER: fake });
  const decision = JSON.parse(result.out).hookSpecificOutput.permissionDecision;
  assert.equal(decision, "deny");
  assert.equal(result.code, 0);
  assert.throws(() => readFileSync(marker));
});

test("the exact echo is forwarded to the configured runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-294-guard-"));
  const allow = join(dir, "allow.json");
  const seen = join(dir, "seen.json");
  writeFileSync(allow, JSON.stringify({
    echo: "echo ocv5-294-echo-marker",
    sed: "sed -n '1p' /fixture",
  }));
  const fake = join(dir, "runner.cjs");
  writeFileSync(fake, `
const fs = require('fs');
let raw = '';
process.stdin.on('data', (c) => raw += c);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(seen)}, raw);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    additionalContext: 'synthetic runner context' } }) + '\\n');
});
`);
  const payload = { tool_name: "Bash", tool_input: { command: "echo ocv5-294-echo-marker" } };
  const result = await run(JSON.stringify(payload), {
    OCV5_294_ALLOWLIST: allow, OCV5_294_EFFICIENCY_RUNNER: fake });
  assert.equal(JSON.parse(result.out).hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), payload);
});
