/**
 * Engine registry fail-closed 测试(M0)。
 *
 * 锁两层语义:
 *   1. resolveEngine 单一权威:codex-native provider → 'codex'(runnerKind 仅接受
 *      缺省/'app-server','exec'/未知 fail-closed);其余 → 'ccb'(M0 model 映射为空)。
 *   2. createEngine 对未注册 engine fail-closed 抛错 —— 原 v5 channel 硬闸
 *      (sessionManager.ts:1266 禁 codex-native)的语义升级形态。M0 codex 未注册,
 *      codex-native agent 在 getOrCreate 必须抛错,不得静默落到 CCB 底座。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/engineRegistry.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createEngine,
  registeredEngines,
  resolveEngine,
  type EngineCreateOpts,
} from "../engine/registry.js";
// side-effect:注册 'ccb' factory(与 sessionManager 的注册路径一致)。
import "../engine/ccbAdapter.js";
import { SessionManager } from "../sessionManager.js";
import type { OpenClaudeConfig, AgentDef } from "@openclaude/storage";

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
    defaults: { model: "glm-5.2" },
  } as unknown as OpenClaudeConfig;
}

function minimalCreateOpts(): EngineCreateOpts {
  return {
    sessionKey: "agent:main:webchat:dm:reg-peer",
    agentId: "main",
    agentBaseDir: "/tmp",
    config: makeConfigStub(),
  } as EngineCreateOpts;
}

describe("resolveEngine", () => {
  test("默认/普通模型 → 'ccb'(M0 model 映射为空)", () => {
    assert.equal(resolveEngine(undefined, { id: "main" }), "ccb");
    assert.equal(resolveEngine("glm-5.2", { id: "main" }), "ccb");
    assert.equal(
      resolveEngine("deepseek-v4-pro", { id: "x", provider: "deepseek" }),
      "ccb",
    );
  });

  test("codex-native provider 显式 pin → 'codex'(runnerKind 缺省/app-server)", () => {
    assert.equal(resolveEngine("gpt-5.5", { id: "codex", provider: "codex-native" }), "codex");
    assert.equal(
      resolveEngine("gpt-5.5", {
        id: "codex",
        provider: "codex-native",
        runnerKind: "app-server",
      }),
      "codex",
    );
  });

  test("codex-native + runnerKind 'exec'/未知 → fail-closed 抛错", () => {
    assert.throws(
      () =>
        resolveEngine("gpt-5.5", {
          id: "codex",
          provider: "codex-native",
          runnerKind: "exec",
        }),
      /fail-closed/,
    );
    assert.throws(
      () =>
        resolveEngine("gpt-5.5", {
          id: "codex",
          provider: "codex-native",
          runnerKind: "weird" as AgentDef["runnerKind"],
        }),
      /fail-closed/,
    );
  });
});

describe("createEngine fail-closed", () => {
  test("'ccb' 已注册,factory 返回 engineId='ccb' 的 adapter", () => {
    assert.ok(registeredEngines().includes("ccb"));
    const adapter = createEngine("ccb", minimalCreateOpts());
    assert.equal(adapter.engineId, "ccb");
    assert.equal(adapter.capabilities.billingMode, "proxy");
    assert.equal(adapter.capabilities.resumeKind, "ccb-session");
  });

  test("未注册 engine('codex' @ M0)→ 抛错", () => {
    assert.throws(() => createEngine("codex", minimalCreateOpts()), /fail-closed/);
  });
});

describe("getOrCreate registry fail-closed(旧 v5 硬闸语义升级)", () => {
  test("codex-native agent → getOrCreate 抛错,不静默落 CCB", async () => {
    const sm = new SessionManager(makeConfigStub());
    await assert.rejects(
      sm.getOrCreate({
        sessionKey: "agent:codex:webchat:dm:gate-peer",
        agent: { id: "codex", provider: "codex-native", model: "gpt-5.5" } as AgentDef,
        channel: "webchat",
        peerId: "gate-peer",
      }),
      /no adapter registered for engine 'codex'/,
    );
  });

  test("普通 agent → 正常构造 'ccb' adapter session", async () => {
    const sm = new SessionManager(makeConfigStub());
    const session = await sm.getOrCreate({
      sessionKey: "agent:main:webchat:dm:gate-peer-2",
      agent: { id: "main", model: "glm-5.2" } as AgentDef,
      channel: "webchat",
      peerId: "gate-peer-2",
    });
    assert.equal(session.runner.engineId, "ccb");
    assert.equal(session.providerTag, "ccb");
  });
});
