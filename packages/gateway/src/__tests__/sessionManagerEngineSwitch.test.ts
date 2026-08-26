/**
 * SessionManager 跨 engine 切模型 + stale-resume 时序回归(M1a)。
 *
 * 覆盖任务书两块:
 *   1. 跨 engine 切模型:同 sessionKey 上 glm-5.2 ↔ gpt-5.6-sol,inbound model 经
 *      resolveEngine 判定 engine 变化 → 沿用 provider-switch teardown(旧 runner
 *      shutdown + 会话槽替换)+ resume-map 按 engine 隔离(codex thread_id 与
 *      CCB session_id 不互喂,cost 基线不跨底座继承);无模型调用不误踢 engine。
 *   2. M0 Codex 评审 nit②:同 turn result 判 stale(_pendingStaleResumeClear
 *      置位)→ 随后 exit/crash → resume-map eviction + runner.clearSessionId
 *      仍执行(不会把 dead id 再持久化回去)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerEngineSwitch.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildNativeModelHandoffPayload,
  buildNativeModelHandoffPrompt,
  SessionManager,
  type AgentSession,
} from "../sessionManager.js";
// side-effect:注册 'ccb' / 'codex' factory。
import "../engine/ccbAdapter.js";
import "../engine/codexAdapter.js";
import { cursorResumeStoreExists, cursorResumeStorePath } from "../engine/cursorAdapter.js";
import type { AgentDef, OpenClaudeConfig } from "@openclaude/storage";

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
    defaults: { model: "glm-5.2" },
  } as unknown as OpenClaudeConfig;
}

interface SmInternals {
  _resumeMap: Map<string, string>;
  _resumeMapTimestamps: Map<string, number>;
  _resumeMapProvider: Map<string, string>;
  _resumeMapLastCost: Map<string, number>;
  _saveResumeMap: () => void;
  _resumeIdFor: (key: string, wantProvider: string, workspacePath?: string) => string | undefined;
  _cursorWorkspacePathForSession: (session: AgentSession) => string | undefined;
}

function makeSm(): { sm: SessionManager; ins: SmInternals } {
  const sm = new SessionManager(makeConfigStub());
  const ins = sm as unknown as SmInternals;
  // 测试不落盘(_saveResumeMap 会写 paths.home/resume-map.json)。
  ins._saveResumeMap = () => {};
  // 隔离:清掉可能从真实 home 加载进来的 resume-map 条目。
  ins._resumeMap.clear();
  ins._resumeMapTimestamps.clear();
  ins._resumeMapProvider.clear();
  ins._resumeMapLastCost.clear();
  return { sm, ins };
}

const KEY = "agent:main:webchat:dm:switch-peer";
const mainAgent = { id: "main", model: "glm-5.2" } as AgentDef;

describe("跨 engine 切模型(glm-5.2 ↔ gpt-5.6-sol 同 sessionKey)", () => {
  test("legacy prewarm → authoritative isolated_v1 recycles the idle runner", async () => {
    const { sm } = makeSm();
    const pinnedCwdAgent = { ...mainAgent, cwd: process.cwd() } as AgentDef;
    const prewarmed = await sm.getOrCreate({
      sessionKey: KEY,
      agent: pinnedCwdAgent,
      channel: "webchat",
      peerId: "switch-peer",
    });
    assert.equal(prewarmed.workspaceMode, "legacy");
    let shutdown = false;
    const originalShutdown = prewarmed.runner.shutdown.bind(prewarmed.runner);
    prewarmed.runner.shutdown = async () => {
      shutdown = true;
      await originalShutdown();
    };
    const isolated = await sm.getOrCreate({
      sessionKey: KEY,
      agent: pinnedCwdAgent,
      channel: "webchat",
      peerId: "switch-peer",
      workspaceMode: "isolated_v1",
    });
    assert.equal(shutdown, true);
    assert.notEqual(isolated, prewarmed);
    assert.equal(isolated.workspaceMode, "isolated_v1");
  });

  test("engine replacement preserves an existing isolated mode when caller omits it", async () => {
    const { sm } = makeSm();
    const pinnedCwdAgent = { ...mainAgent, cwd: process.cwd() } as AgentDef;
    const isolated = await sm.getOrCreate({
      sessionKey: KEY,
      agent: pinnedCwdAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
      workspaceMode: "isolated_v1",
    });
    const switched = await sm.getOrCreate({
      sessionKey: KEY,
      agent: pinnedCwdAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "gpt-5.6-sol",
    });
    assert.notEqual(switched, isolated);
    assert.equal(switched.workspaceMode, "isolated_v1");
  });

  test("ccb → codex:teardown 旧 runner,resume-map/cost 基线不串", async () => {
    const { sm, ins } = makeSm();
    const ccbSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    assert.equal(ccbSession.runner.engineId, "ccb");
    assert.equal(ccbSession.providerTag, "ccb");

    // 模拟 CCB 已学到 native session id + cost 基线(ccb-tagged)。
    ins._resumeMap.set(KEY, "ccb-native-id-1");
    ins._resumeMapProvider.set(KEY, "ccb");
    ins._resumeMapLastCost.set(KEY, 1.25);
    ccbSession.ccbSessionId = "ccb-native-id-1";

    let oldShutdown = false;
    const origShutdown = ccbSession.runner.shutdown.bind(ccbSession.runner);
    ccbSession.runner.shutdown = async () => {
      oldShutdown = true;
      await origShutdown();
    };

    const codexSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "gpt-5.6-sol",
    });
    assert.equal(oldShutdown, true, "engine 切换必须 shutdown 旧 runner");
    assert.notEqual(codexSession, ccbSession, "会话槽必须替换为新 AgentSession");
    assert.equal(codexSession.runner.engineId, "codex");
    assert.equal(codexSession.providerTag, "codex");
    assert.equal(codexSession.model, "gpt-5.6-sol");
    // resume-map 隔离:ccb-tagged 条目不得喂给 codex
    assert.equal(ins._resumeIdFor(KEY, "codex"), undefined);
    assert.equal(codexSession.runner.nativeSessionId, null, "codex 不得继承 CCB session id");
    // cost 基线 provider-gated:codex 不继承 CCB 历史 cumulative
    assert.equal(codexSession.totalCostUSD, 0);
    assert.equal(codexSession._lastCcbCumulativeCost, 0);
    // 新 engine 的首 turn 走 compact transcript preamble 路径(注入标记为空)
    assert.equal(codexSession._historicalContextInjected, undefined);
  });

  test("codex → ccb 切回:thread_id 不喂 CCB;session_id 事件按 engine 打 tag", async () => {
    const { sm, ins } = makeSm();
    const codexSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "gpt-5.6-sol",
    });
    assert.equal(codexSession.providerTag, "codex");
    // codex 学到 thread id → resume-map 以 engine tag('codex')落账
    codexSession.runner.emit("session_id", "thr-codex-7");
    assert.equal(ins._resumeMapProvider.get(KEY), "codex");
    assert.equal(codexSession.ccbSessionId, "thr-codex-7", "字段语义 = native session id");
    ins._resumeMap.set(KEY, "thr-codex-7");

    const ccbSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    assert.equal(ccbSession.runner.engineId, "ccb");
    // codex-tagged thread id 不得作为 CCB --resume
    assert.equal(ins._resumeIdFor(KEY, "ccb"), undefined);
    assert.equal(ccbSession.runner.nativeSessionId, null);
  });

  test("无模型调用(cron/pre-warm/hello)不误踢现存 engine", async () => {
    const { sm } = makeSm();
    const codexSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "gpt-5.6-sol",
    });
    const again = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent, // agent.model=glm-5.2,但 opts.model 缺省 → 不参与比较
      channel: "webchat",
      peerId: "switch-peer",
    });
    assert.equal(again, codexSession, "无模型调用必须复用现存 codex session");
    assert.equal(again.providerTag, "codex");
  });

  test("同 engine 内换模型不 teardown(交给 submit 的 setModel+shutdown)", async () => {
    const { sm } = makeSm();
    const s1 = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    const s2 = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "deepseek-v4-pro", // 仍是 ccb engine
    });
    assert.equal(s2, s1, "ccb 内部换模型不得替换 AgentSession");
  });

  test("codex-native provider pin:无 inbound model 也参与 engine 判定", async () => {
    const { sm } = makeSm();
    const ccbSession = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    assert.equal(ccbSession.providerTag, "ccb");
    const pinned = await sm.getOrCreate({
      sessionKey: KEY,
      agent: { id: "main", model: "gpt-5.6-sol", provider: "codex-native" } as AgentDef,
      channel: "webchat",
      peerId: "switch-peer",
      // 无 opts.model —— provider pin 单独触发比较
    });
    assert.notEqual(pinned, ccbSession);
    assert.equal(pinned.providerTag, "codex");
  });
});

describe("stale-resume 时序回归(M0 Codex 评审 nit②)", () => {
  test("turn 判 stale 置位 → 随后 crash exit → resume-map eviction + clearSessionId 仍执行", async () => {
    const { sm, ins } = makeSm();
    const session = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    // 前置态:resume-map 有 dead id,turn 已判 stale(finalizeTurn 路径置位,
    // 该置位逻辑由 sessionManagerEngineTurn.test 单独锁死)。
    ins._resumeMap.set(KEY, "dead-beef");
    ins._resumeMapTimestamps.set(KEY, Date.now());
    ins._resumeMapProvider.set(KEY, "ccb");
    ins._resumeMapLastCost.set(KEY, 0.5);
    session.ccbSessionId = "dead-beef";
    session._pendingStaleResumeClear = true;

    let clearCalled = 0;
    const origClear = session.runner.clearSessionId.bind(session.runner);
    session.runner.clearSessionId = () => {
      clearCalled++;
      origClear();
    };

    // crash exit(getOrCreate 里注册的 'exit' handler 消费 stale 标记)
    session.runner.emit("exit", { code: 1, signal: null, crashed: true });

    assert.equal(ins._resumeMap.has(KEY), false, "dead id 必须从 resume-map 逐出");
    assert.equal(ins._resumeMapProvider.has(KEY), false);
    assert.equal(ins._resumeMapLastCost.has(KEY), false);
    assert.equal(session.ccbSessionId, null);
    assert.equal(session._pendingStaleResumeClear, false, "标记消费后必须复位");
    assert.equal(clearCalled, 1, "runner 内存中的 id 必须同步清,否则下次 start 又 --resume dead id");
  });

  test("非 stale crash:ccbSessionId 回写 resume-map(恢复路径不受 nit② 影响)", async () => {
    const { sm, ins } = makeSm();
    const session = await sm.getOrCreate({
      sessionKey: KEY,
      agent: mainAgent,
      channel: "webchat",
      peerId: "switch-peer",
      model: "glm-5.2",
    });
    session.ccbSessionId = "alive-id-3";
    session._pendingStaleResumeClear = false;

    session.runner.emit("exit", { code: 137, signal: null, crashed: true });

    assert.equal(ins._resumeMap.get(KEY), "alive-id-3", "非 stale crash 必须保留可恢复 id");
    assert.equal(session.ccbSessionId, "alive-id-3");
  });
});


describe("Cursor resume workspace path uses the pinned agent cwd", () => {
  test("stale-store check hashes pinned agent.cwd, not the default workspace", async () => {
    const pinned = await mkdtemp(path.join(tmpdir(), "oc-cursor-pinned-cwd-"));
    const defaultWs = await mkdtemp(path.join(tmpdir(), "oc-cursor-default-ws-"));
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const store = cursorResumeStorePath(pinned, sessionId);
    await mkdir(path.dirname(store), { recursive: true });
    await writeFile(store, "");
    const oldDefault = process.env.OPENCLAUDE_DEFAULT_WORKSPACE;
    process.env.OPENCLAUDE_DEFAULT_WORKSPACE = defaultWs;
    const key = "agent:main:webchat:dm:cursor-pinned-cwd";
    const { sm, ins } = makeSm();
    ins._resumeMap.set(key, sessionId);
    ins._resumeMapProvider.set(key, "cursor");
    try {
      const session = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: "main", cwd: pinned, model: "cursor-auto" } as AgentDef,
        channel: "webchat",
        peerId: "cursor-pinned-cwd",
        model: "cursor-auto",
      });
      assert.equal(session.workspaceCwd, pinned);
      assert.equal(session.runner.engineId, "cursor");
      assert.equal(session.runner.nativeSessionId, sessionId);
      const fromSession = ins._cursorWorkspacePathForSession(session);
      assert.ok(fromSession);
      assert.equal(cursorResumeStoreExists(fromSession, sessionId), true);
      assert.equal(cursorResumeStoreExists(defaultWs, sessionId), false);
      assert.equal(ins._resumeIdFor(key, "cursor", fromSession), sessionId);
      assert.notEqual(fromSession, defaultWs);
    } finally {
      if (oldDefault === undefined) delete process.env.OPENCLAUDE_DEFAULT_WORKSPACE;
      else process.env.OPENCLAUDE_DEFAULT_WORKSPACE = oldDefault;
      await rm(path.dirname(store), { recursive: true, force: true });
      await rm(pinned, { recursive: true, force: true });
      await rm(defaultWs, { recursive: true, force: true });
    }
  });
});


describe("prepared native model handoff fencing", () => {
  test("requires the exact switch generation before replacing engines", async () => {
    const { sm } = makeSm();
    const source = await sm.getOrCreate({
      sessionKey: KEY, agent: mainAgent, channel: "webchat", peerId: "switch-peer", model: "glm-5.2",
    });
    source._modelSwitchTransition = {
      id: "model-switch:test:1", sourceModel: "glm-5.2", targetModel: "gpt-5.6-sol",
      sourceEngine: "ccb", state: "prepared", summaryText: "native summary",
    };
    await assert.rejects(() => sm.getOrCreate({
      sessionKey: KEY, agent: mainAgent, channel: "webchat", peerId: "switch-peer", model: "gpt-5.6-sol",
    }), /MODEL_SWITCH_IN_PROGRESS/);
    const target = await sm.getOrCreate({
      sessionKey: KEY, agent: mainAgent, channel: "webchat", peerId: "switch-peer", model: "gpt-5.6-sol",
      modelSwitchId: "model-switch:test:1",
    });
    assert.equal(target.providerTag, "codex");
    assert.equal(target._modelSwitchTransition?.summaryText, "native summary");
  });

  test("cancels only the exact abandoned generation and lets the source model continue", async () => {
    const { sm } = makeSm();
    const source = await sm.getOrCreate({
      sessionKey: KEY, agent: mainAgent, channel: "webchat", peerId: "switch-peer", model: "glm-5.2",
    });
    source._modelSwitchTransition = {
      id: "model-switch:test:cancel", sourceModel: "glm-5.2", targetModel: "gpt-5.6-sol",
      sourceEngine: "ccb", state: "prepared", summaryText: "native summary", expiresAt: Date.now() + 60_000,
    };
    assert.equal(sm.cancelModelSwitch(source, "model-switch:test:wrong"), false);
    assert.ok(source._modelSwitchTransition);
    assert.equal(sm.cancelModelSwitch(source, "model-switch:test:cancel"), true);
    assert.equal(source._modelSwitchTransition, undefined);

    source._modelSwitchTransition = {
      id: "model-switch:test:expired", sourceModel: "glm-5.2", targetModel: "gpt-5.6-sol",
      sourceEngine: "ccb", state: "prepared", summaryText: "native summary", expiresAt: Date.now() - 1,
    };
    const resumed = await sm.getOrCreate({
      sessionKey: KEY, agent: mainAgent, channel: "webchat", peerId: "switch-peer", model: "glm-5.2",
    });
    assert.equal(resumed, source);
    assert.equal(resumed._modelSwitchTransition, undefined);
  });

  test("builds an isolated target prompt from native handoff plus current user input", () => {
    const prompt = buildNativeModelHandoffPrompt("native summary", "continue");
    assert.match(prompt, /<openclaude_native_model_handoff>/);
    assert.match(prompt, /native summary/);
    assert.match(prompt, /<current_user_message>\ncontinue/);
    const image = { type: "image", source: { type: "url", url: "https://example.test/a.png" } };
    const payload = buildNativeModelHandoffPayload("native summary", [image]);
    assert.ok(Array.isArray(payload));
    assert.match(String(payload[0]?.text), /native summary/);
    assert.deepEqual(payload[1], image);
    const digest = `${"a".repeat(64)}.png`;
    const withHints = buildNativeModelHandoffPrompt(
      "native summary",
      "continue",
      `Earlier user turns attached these local files. Read them if the task still depends on their contents.\n- \`/home/agent/.openclaude/uploads/${digest}\``,
    );
    assert.match(withHints, new RegExp(`/home/agent/\\.openclaude/uploads/${digest}`));
    assert.match(withHints, /<current_user_message>\ncontinue/);
  });
});
