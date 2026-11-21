/**
 * B4 (OCV5-828 R2): Antigravity 主引擎真实 adapter 显式只读回合拒启动、普通回合正常工作验证。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityAdvisorReadOnly.test.ts
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { paths, type OpenClaudeConfig } from "@openclaude/storage";
import { AntigravityAdapter } from "../engine/antigravityAdapter.js";
import type { EngineCreateOpts } from "../engine/registry.js";

test("B4: AntigravityAdapter refuses explicit readOnly turn before spawn (zero write side effects), while normal turns still run", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "oc-agy-readonly-"));
  const target = join(dir, "protected.md");
  const spawnMarker = join(dir, "spawned.txt");
  const fakeBin = join(dir, "fake-antigravity.cjs");

  await writeFile(target, "untouched-content");
  await writeFile(
    fakeBin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(spawnMarker)}, 'spawned\\n');
fs.writeFileSync(${JSON.stringify(target)}, 'modified-by-normal-turn');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ event: 'init', conversation_id: '11111111-1111-4111-8111-111111111111', model: 'gemini-4-carbon-medium' }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: '11111111-1111-4111-8111-111111111111', status: 'SUCCESS', response: 'normal turn ok' } }));
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
    // 1) Explicit readOnly turn MUST fail closed before spawn — zero CLI launch, zero disk mutation!
    const readOnlyRun = adapter.submitTurn({
      input: "只读审阅 protected.md，禁止修改文件",
      readOnly: true,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    });
    await assert.rejects(() => readOnlyRun.submitted, /ANTIGRAVITY_READ_ONLY_UNSUPPORTED/);
    const roSummary = await readOnlyRun.summary;
    assert.equal(roSummary?.isError, true);
    assert.equal(await readFile(target, "utf8"), "untouched-content");
    await assert.rejects(() => readFile(spawnMarker, "utf8"), /ENOENT/);

    // 2) Normal turn (readOnly: false) proceeds and runs normally!
    const normalRun = adapter.submitTurn({
      input: "请正常更新 protected.md",
      readOnly: false,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    });
    await normalRun.submitted;
    const normalSummary = await normalRun.summary;
    await adapter.waitForOutputDrain();
    assert.equal(normalSummary?.isError, false, JSON.stringify(normalSummary));
    assert.equal(normalSummary?.assistantText, "normal turn ok");
    assert.equal(await readFile(target, "utf8"), "modified-by-normal-turn");
  } finally {
    await adapter.shutdown();
    if (oldBin === undefined) delete process.env.OC_ANTIGRAVITY_CLI_BIN;
    else process.env.OC_ANTIGRAVITY_CLI_BIN = oldBin;
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME;
    else process.env.OPENCLAUDE_HOME = oldHome;
    paths.home = oldStorageHome;
    await rm(dir, { recursive: true, force: true });
  }
});
