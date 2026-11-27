/**
 * Local Antigravity read-only turn hard PreToolUse guard & fail-closed
 * projection verification (upgraded from B4 OCV5-828 to OCV5-893 local hard
 * read-only sandbox).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityAdvisorReadOnly.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { paths, type OpenClaudeConfig } from "@openclaude/storage";
import { AntigravityAdapter } from "../engine/antigravityAdapter.js";
import {
  ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE,
  _readOnlyGuardInternals,
} from "../engine/antigravityReadOnlyGuard.js";
import type { EngineCreateOpts } from "../engine/registry.js";

test("OCV5-893: AntigravityAdapter projects isolated PreToolUse hard read-only guard, cleans up, fails closed without python3, and preserves normal turns", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-agy-readonly-"));
  const target = join(dir, "protected.md");
  const spawnLog = join(dir, "spawns.jsonl");
  const fakeBin = join(dir, "fake-antigravity.cjs");

  await writeFile(target, "untouched-content");
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline');
const home = process.env.HOME;
const hooksPath = path.join(home, '.gemini', 'config', 'hooks.json');
const hasHooks = fs.existsSync(hooksPath);
let writeDecision = null;
let readDecision = null;
if (hasHooks) {
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const cmd = hooks['openclaude-local-readonly'].PreToolUse[0].hooks[0].command;
  writeDecision = JSON.parse(cp.execSync(cmd, { input: JSON.stringify({ toolCall: { name: 'write_file' } }), encoding: 'utf8' }));
  readDecision = JSON.parse(cp.execSync(cmd, { input: JSON.stringify({ toolCall: { name: 'read_file' } }), encoding: 'utf8' }));
}
if (!hasHooks) {
  fs.writeFileSync(${JSON.stringify(target)}, 'modified-by-normal-turn');
}
fs.appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({ home, hasHooks, ocReadOnly: process.env.OC_READ_ONLY_TURN ?? null, writeDecision, readDecision }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ event: 'init', conversation_id: '11111111-1111-4111-8111-111111111111', model: 'gemini-4-carbon-medium' }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: '11111111-1111-4111-8111-111111111111', status: 'SUCCESS', response: hasHooks ? 'readonly turn ok' : 'normal turn ok' } }));
  process.exit(0);
});
`,
  );
  await chmod(fakeBin, 0o755);

  const oldBin = process.env.OC_ANTIGRAVITY_CLI_BIN;
  const oldHome = process.env.OPENCLAUDE_HOME;
  const oldStorageHome = paths.home;
  process.env.OC_ANTIGRAVITY_CLI_BIN = fakeBin;
  process.env.OPENCLAUDE_HOME = join(dir, "home");
  paths.home = join(dir, "storage-home");

  const opts: EngineCreateOpts = {
    agentId: "main",
    agentBaseDir: dir,
    sessionKey: "agent:main:webchat:dm:agy-readonly-b4",
    model: "antigravity-gemini-4-carbon",
    config: {
      version: 1,
      gateway: { bind: "127.0.0.1", port: 18789, accessToken: "test" },
      auth: { mode: "api_key", claudeCodePath: dir },
      defaults: { model: "antigravity-gemini-4-carbon" },
    } as OpenClaudeConfig,
  } as EngineCreateOpts;

  const adapter = new AntigravityAdapter(opts);
  adapter.on("error", () => {});
  adapter.setAntigravityRoute({
    routeToken: "b".repeat(64),
    baseUrl: `http://127.0.0.1:18789/internal/v5/antigravity-relay/route/${"b".repeat(64)}`,
    accessToken: "test-access-token",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  try {
    // 1) Explicit readOnly turn runs inside isolated readonly-turns/ dir with PreToolUse guard denying write_file and allowing read_file
    const readOnlyRun = adapter.submitTurn({
      input: "只读审阅 protected.md，禁止修改文件",
      readOnly: true,
      traceId: "0123456789abcdef0123456789abcdef",
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    });
    await readOnlyRun.submitted;
    const roSummary = await readOnlyRun.summary;
    await adapter.waitForOutputDrain();
    assert.equal(roSummary?.isError, false, JSON.stringify(roSummary));
    assert.equal(roSummary?.assistantText, "readonly turn ok");
    assert.equal(await readFile(target, "utf8"), "untouched-content");

    const [roSpawn] = (await readFile(spawnLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        home: string;
        hasHooks: boolean;
        ocReadOnly: string | null;
        writeDecision: { decision: string; reason: string };
        readDecision: { decision: string };
      });
    assert.match(roSpawn.home, /\/readonly-turns\/ro-0123456789abcdef0123456789abcdef-[0-9a-f]+$/);
    assert.equal(roSpawn.hasHooks, true);
    assert.equal(roSpawn.ocReadOnly, "1");
    assert.deepEqual(roSpawn.writeDecision, { decision: "deny", reason: "readonly_turn_forbidden:write_file" });
    assert.deepEqual(roSpawn.readDecision, { decision: "allow" });
    assert.equal(existsSync(roSpawn.home), false, "isolated read-only launchHome cleaned after turn");

    // 2) Fail-closed when python3 guard cannot be installed (never spawns CLI)
    _readOnlyGuardInternals.setPythonCandidatesOverride(["/nonexistent/python3"]);
    const failClosedRun = adapter.submitTurn({
      input: "无 python3 时必须 fail-closed 拒绝启动",
      readOnly: true,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 1 },
      toolUseIdToName: new Map(),
    });
    await assert.rejects(() => failClosedRun.submitted, new RegExp(ANTIGRAVITY_READ_ONLY_GUARD_UNAVAILABLE));
    const failSummary = await failClosedRun.summary;
    assert.equal(failSummary?.isError, true);
    _readOnlyGuardInternals.setPythonCandidatesOverride(null);

    // 3) Normal turn (readOnly: false) runs without read-only hook pollution (fresh conversation on fake CLI)
    adapter.clearSessionId();
    const normalRun = adapter.submitTurn({
      input: "请正常更新 protected.md",
      readOnly: false,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 2 },
      toolUseIdToName: new Map(),
    });
    await normalRun.submitted;
    const normalSummary = await normalRun.summary;
    await adapter.waitForOutputDrain();
    assert.equal(normalSummary?.isError, false, JSON.stringify(normalSummary));
    assert.equal(normalSummary?.assistantText, "normal turn ok");
    assert.equal(await readFile(target, "utf8"), "modified-by-normal-turn");

    const spawns = (await readFile(spawnLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { home: string; hasHooks: boolean; ocReadOnly: string | null });
    assert.equal(spawns.length, 2, "fail-closed turn must not have spawned CLI");
    assert.equal(spawns[1].hasHooks, false);
    assert.equal(spawns[1].ocReadOnly, null);
    assert.match(spawns[1].home, /\/launch\//);
  } finally {
    _readOnlyGuardInternals.setPythonCandidatesOverride(null);
    await adapter.shutdown();
    if (oldBin === undefined) delete process.env.OC_ANTIGRAVITY_CLI_BIN;
    else process.env.OC_ANTIGRAVITY_CLI_BIN = oldBin;
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = oldHome;
    paths.home = oldStorageHome;
    await rm(dir, { recursive: true, force: true });
  }
});
