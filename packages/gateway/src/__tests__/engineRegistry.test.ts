/**
 * Engine registry fail-closed 测试(M0 → M1a 更新)。
 *
 * 锁三层语义:
 *   1. resolveEngine 单一权威:GPT-5.6 三型号 → 'codex'
 *      + codex-native provider 显式 pin(runnerKind 仅接受缺省/'app-server',
 *      'exec'/未知 fail-closed);其余 → 'ccb'。
 *   2. createEngine 对未注册 engine fail-closed 抛错(用假 engine id 锁语义 ——
 *      M1a 起 'codex' 已注册)。
 *   3. getOrCreate:codex-native / GPT-5.6 → 'codex' adapter;runnerKind 'exec'
 *      仍 fail-closed。
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
// side-effect:注册 'ccb' / 'codex' factory(与 sessionManager 的注册路径一致)。
import "../engine/ccbAdapter.js";
import "../engine/codexAdapter.js";
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
  test("默认/普通模型 → 'ccb'", () => {
    assert.equal(resolveEngine(undefined, { id: "main" }), "ccb");
    assert.equal(resolveEngine("glm-5.2", { id: "main" }), "ccb");
    assert.equal(
      resolveEngine("deepseek-v4-pro", { id: "x", provider: "deepseek" }),
      "ccb",
    );
  });

  test("GPT-5.6 三型号 → 'codex'(任意 agent,无需 provider pin);GPT-5.5 已移除", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      assert.equal(resolveEngine(model, { id: "main" }), "codex");
    }
    assert.equal(resolveEngine("gpt-5.5", { id: "main" }), "ccb");
  });

  test("codex-native provider 显式 pin → 'codex'(runnerKind 缺省/app-server)", () => {
    assert.equal(resolveEngine("gpt-5.6-sol", { id: "codex", provider: "codex-native" }), "codex");
    assert.equal(
      resolveEngine("gpt-5.6-terra", {
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
        resolveEngine("gpt-5.6-sol", {
          id: "codex",
          provider: "codex-native",
          runnerKind: "exec",
        }),
      /fail-closed/,
    );
    assert.throws(
      () =>
        resolveEngine("gpt-5.6-sol", {
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

  test("M1a:'codex' 已注册,factory 返回 engineId='codex' 的 adapter", () => {
    assert.ok(registeredEngines().includes("codex"));
    const adapter = createEngine("codex", minimalCreateOpts());
    assert.equal(adapter.engineId, "codex");
    assert.equal(adapter.capabilities.billingMode, "engine-reported");
    assert.equal(adapter.capabilities.resumeKind, "codex-thread");
    assert.equal(adapter.capabilities.needsServerRequestId, true);
  });

  test("未注册 engine → 抛错(fail-closed 语义,假 engine id 锁死)", () => {
    assert.throws(() => createEngine("no-such-engine", minimalCreateOpts()), /fail-closed/);
  });
});

describe("getOrCreate engine 路由(M1a)", () => {
  test("codex-native agent → 'codex' adapter session(旧硬闸解除)", async () => {
    const sm = new SessionManager(makeConfigStub());
    const session = await sm.getOrCreate({
      sessionKey: "agent:codex:webchat:dm:gate-peer",
      agent: { id: "codex", provider: "codex-native", model: "gpt-5.6-sol" } as AgentDef,
      channel: "webchat",
      peerId: "gate-peer",
    });
    assert.equal(session.runner.engineId, "codex");
    assert.equal(session.providerTag, "codex");
  });

  test("普通 agent + inbound model gpt-5.6-terra → 'codex' adapter session", async () => {
    const sm = new SessionManager(makeConfigStub());
    const session = await sm.getOrCreate({
      sessionKey: "agent:main:webchat:dm:gate-peer-gpt",
      agent: { id: "main", model: "glm-5.2" } as AgentDef,
      channel: "webchat",
      peerId: "gate-peer-gpt",
      model: "gpt-5.6-terra",
    });
    assert.equal(session.runner.engineId, "codex");
    assert.equal(session.providerTag, "codex");
    assert.equal(session.model, "gpt-5.6-terra");
  });

  test("codex-native + runnerKind 'exec' → getOrCreate 仍 fail-closed 抛错", async () => {
    const sm = new SessionManager(makeConfigStub());
    await assert.rejects(
      sm.getOrCreate({
        sessionKey: "agent:codex:webchat:dm:gate-peer-exec",
        agent: {
          id: "codex",
          provider: "codex-native",
          model: "gpt-5.6-sol",
          runnerKind: "exec",
        } as AgentDef,
        channel: "webchat",
        peerId: "gate-peer-exec",
      }),
      /fail-closed/,
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
