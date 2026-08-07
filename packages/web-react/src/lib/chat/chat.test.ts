import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyPartialJsonDelta,
  backoffDelay,
  classifyClose,
  classifyEmptyTurn,
  contextRebuiltNotice,
  countAnswerBlocks,
  deriveConnBanner,
  EXPECTED_TURN_ERR_CODES,
  findOrCreateStreamingRow,
  friendlyBridgeErrorMessage,
  getFrameSeqCursor,
  loadOlderHistoryLabel,
  nonAuthPolicyCloseInfo,
  normalizeBridgeErrorCode,
  onopenSetInitialStatus,
  parsePartialJson,
  shouldAutoContinueEmptyTurn,
} from "./pure";
import {
  addMessage,
  type ChatMessage,
  clearTurnTiming,
  createSession,
  isRetryingTurnStatus,
  isServerAuthoredRow,
  resetReplyTracker,
  shouldApplyGoalSnapshot,
} from "./model";
import {
  applyCallUsage,
  applyCostCharged,
  applyCostWaived,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyResumeFailed,
  applyTurnStatus,
  applyTurnUsage,
  normalizeDelegateCards,
  normalizeGoalCards,
  type FrameEffects,
} from "./reducer";
import {
  ChatSocket,
  automaticTurnRecoveryTarget,
  exactUserReplayPayload,
  interruptedContinuationIdentity,
  interruptedContinuationTarget,
  messageAttemptIdempotencyKey,
  preciseRetryEligible,
  type ChatSocketDeps,
} from "./socket";
import type {
  OutboundMessageWire,
  OutboundPermissionRequestWire,
  OutboundPermissionSettledWire,
} from "./frames";
import { childSignature, messageSignature } from "./render";

// ─── helpers ──────────────────────────────────────────────────────────
function sess(id = "s1", agentId = "main") {
  const s = createSession({ id, agentId });
  return s;
}
type AnyFrame = Record<string, unknown>;
function msgFrame(over: AnyFrame): OutboundMessageWire {
  return {
    type: "outbound.message",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    blocks: [],
    isFinal: false,
    ...over,
  } as unknown as OutboundMessageWire;
}

// ═══════════════ §8 partialJson offset 累加器 ═══════════════
describe("applyPartialJsonDelta (§8)", () => {
  test("offset===length → set (append)", () => {
    expect(applyPartialJsonDelta("", { partialJsonDelta: '{"a"', partialJsonOffset: 0 })).toEqual({
      action: "set",
      value: '{"a"',
    });
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: ":1}", partialJsonOffset: 4 })).toEqual({
      action: "set",
      value: '{"a":1}',
    });
  });
  test("offset mismatch (dup/reorder/ring overlap) → drop", () => {
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: "x", partialJsonOffset: 0 })).toEqual({ action: "drop" });
    expect(applyPartialJsonDelta('{"a"', { partialJsonDelta: "x", partialJsonOffset: 99 })).toEqual({ action: "drop" });
  });
  test("no delta fields → keep", () => {
    expect(applyPartialJsonDelta("x", {})).toEqual({ action: "keep" });
    expect(applyPartialJsonDelta("x", { partialJsonDelta: "y" })).toEqual({ action: "keep" });
  });
  test("recovery: after drop, offset===0 frame reseeds from null", () => {
    expect(applyPartialJsonDelta(null, { partialJsonDelta: "{", partialJsonOffset: 0 })).toEqual({
      action: "set",
      value: "{",
    });
  });
});

describe("parsePartialJson", () => {
  test("complete object", () => {
    expect(parsePartialJson('{"file_path":"/a","x":1}')).toEqual({ file_path: "/a", x: 1 });
  });
  test("partial trailing string value extracted", () => {
    expect(parsePartialJson('{"old_string":"hel')).toEqual({ old_string: "hel" });
  });
  test("top-level non-object → {}", () => {
    expect(parsePartialJson("[1,2]")).toEqual({});
    expect(parsePartialJson("garbage")).toEqual({});
  });
  test("never throws on adversarial input", () => {
    for (const s of ["", "{", '{"', '{"a":', '{"a":{', '{"a":"\\u', "{}}}", '{"a":\\']) {
      expect(() => parsePartialJson(s)).not.toThrow();
    }
  });
});

// ═══════════════ §3 frameSeq 游标 ═══════════════
describe("getFrameSeqCursor (§3 严禁全局单游标)", () => {
  test("peer: prefix falls back to legacy single cursor", () => {
    expect(getFrameSeqCursor(undefined, 7, "peer:s1")).toBe(7);
  });
  test("agent-scoped sessionKey never inherits legacy cursor (starts at 0)", () => {
    // A 容器推到 50 后 B 容器从 1 起的帧不能被全局游标当 dup 丢掉。
    expect(getFrameSeqCursor({ "agent:a:webchat:dm:s1": 50 }, 50, "agent:b:webchat:dm:s1")).toBe(0);
  });
  test("byKey hit wins", () => {
    expect(getFrameSeqCursor({ "agent:a:webchat:dm:s1": 12 }, 0, "agent:a:webchat:dm:s1")).toBe(12);
  });
});

// ═══════════════ 空轮分类 + auto-continue cap ═══════════════
describe("classifyEmptyTurn / shouldAutoContinueEmptyTurn", () => {
  test("thinking is NOT an answer (GLM 想了没说 bug)", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "t1", role: "thinking" },
    ];
    const r = classifyEmptyTurn({ messages, targetMsgId: "u1", hasAnswerOutput: false, stopReason: "end_turn" });
    expect(r.insert).toBe(true);
  });
  test("answer-bearing message after target → no notice", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ];
    expect(classifyEmptyTurn({ messages, targetMsgId: "u1", hasAnswerOutput: false }).insert).toBe(false);
  });
  test("countAnswerBlocks whitelist excludes thinking/tool_result", () => {
    expect(countAnswerBlocks([{ kind: "thinking" }, { kind: "tool_result" }])).toBe(0);
    expect(countAnswerBlocks([{ kind: "text" }, { kind: "tool_use" }, { kind: "plan" }])).toBe(3);
  });
  test("auto-continue only on end_turn, capped once", () => {
    const messages = [{ id: "u1", role: "user" }];
    expect(shouldAutoContinueEmptyTurn({ messages, targetMsgId: "u1", stopReason: "end_turn" })).toBe(true);
    expect(shouldAutoContinueEmptyTurn({ messages, targetMsgId: "u1", stopReason: "max_tokens" })).toBe(false);
    const withAuto = [
      { id: "u1", role: "user" },
      { id: "u2", role: "user", _isAutoRetry: true },
    ];
    expect(shouldAutoContinueEmptyTurn({ messages: withAuto, targetMsgId: "u1", stopReason: "end_turn" })).toBe(false);
  });
});

// ═══════════════ §5 close code 语义 ═══════════════
describe("classifyClose / nonAuthPolicyCloseInfo (§5)", () => {
  test("4503 reads retryAfterSec clamp [1s,60s] (12-min loop fix)", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 5, reason: "provisioning" }));
    expect(d.action).toBe("reconnect");
    expect(d.serverHintedDelay).toBeGreaterThanOrEqual(5000);
    expect(d.serverHintedDelay).toBeLessThan(6000);
    expect(d.provisioning).toBe(true);
  });
  test("4503 retryAfterSec clamped to 60s upper bound", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 9999, reason: "starting" }));
    expect(d.serverHintedDelay).toBeGreaterThanOrEqual(60000);
    expect(d.serverHintedDelay).toBeLessThan(60600);
  });
  test("1008 → auth refresh path", () => {
    expect(classifyClose(1008, "").action).toBe("auth_1008");
  });
  test("4506 insufficient_credits → policy + billing", () => {
    const d = classifyClose(4506, "");
    expect(d.action).toBe("policy");
    expect(d.policy?.billing).toBe(true);
  });
  test("plain 1006 → standard reconnect, no server hint", () => {
    const d = classifyClose(1006, "");
    expect(d.action).toBe("reconnect");
    expect(d.serverHintedDelay).toBe(0);
  });
  test("nonAuthPolicyCloseInfo recognizes reason strings", () => {
    expect(nonAuthPolicyCloseInfo(0, "too_many_connections")?.status).toBe("连接数超限");
    expect(nonAuthPolicyCloseInfo(0, "unauthorized_model")?.status).toBe("模型未开通");
    expect(nonAuthPolicyCloseInfo(1006, "")).toBeNull();
  });
  test("4503 provisioning now carries a friendly closeReasonLabel too", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 3, reason: "provisioning" }));
    expect(d.provisioning).toBe(true);
    expect(d.closeReasonLabel).toContain("环境启动中");
  });
  test("4504 starting sets label but NOT provisioning boolean (gate is 4503-only)", () => {
    const d = classifyClose(4504, JSON.stringify({ retryAfterSec: 3, reason: "starting" }));
    expect(d.provisioning).toBe(false);
    expect(d.closeReasonLabel).toContain("环境启动中");
  });
  test("known error reason still maps to its label", () => {
    const d = classifyClose(4503, JSON.stringify({ retryAfterSec: 3, reason: "image_outdated" }));
    expect(d.closeReasonLabel).toBe("运行镜像更新中，稍后自动重试");
  });
  test("4509 服务重启 → 瞬态 reconnect + 「服务更新中」横幅,绝不落 policy/错误路径", () => {
    const d = classifyClose(4509, "server_restart");
    expect(d.action).toBe("reconnect");
    expect(d.serverHintedDelay).toBe(0);
    expect(d.provisioning).toBe(false);
    expect(d.closeReasonLabel).toContain("服务更新中");
  });
  test("4509 不被误判为连接数超限(与 4505 kick 语义分流)", () => {
    expect(nonAuthPolicyCloseInfo(4509, "server_restart")).toBeNull();
  });
  test("backoff 2/4/8/16/30s ladder + jitter cap", () => {
    expect(backoffDelay(0)).toBeGreaterThanOrEqual(2000);
    expect(backoffDelay(0)).toBeLessThan(3001);
    expect(backoffDelay(10)).toBeLessThan(31001); // capped 30s + jitter
  });
});

describe("deriveConnBanner (弱网重连三态)", () => {
  test("connected → 不显条 (null)", () => {
    expect(
      deriveConnBanner({ cls: "connected", label: "已连接", browserOnline: true, provisioning: false }),
    ).toBeNull();
  });
  test("浏览器离线 → 「网络已断开」warning (无倒计时归因用户侧断网)", () => {
    const b = deriveConnBanner({ cls: "disconnected", label: "离线", browserOnline: false, provisioning: false });
    expect(b).toEqual({ tone: "warning", text: "网络已断开，恢复后自动重连" });
  });
  test("provisioning(在线) → 「环境启动中」info", () => {
    const b = deriveConnBanner({
      cls: "disconnected",
      label: "环境启动中，正在为你准备工作区 · 3 秒后重试…",
      browserOnline: true,
      provisioning: true,
    });
    expect(b).toEqual({ tone: "info", text: "环境启动中，正在为你准备工作区…" });
  });
  test("服务端重连(在线,非供给) → 呈现 status.label(含 closeReasonLabel + 倒计时)", () => {
    const b = deriveConnBanner({
      cls: "disconnected",
      label: "运行镜像更新中，稍后自动重试 · 8 秒后重试…",
      browserOnline: true,
      provisioning: false,
    });
    expect(b).toEqual({ tone: "warning", text: "运行镜像更新中，稍后自动重试 · 8 秒后重试…" });
  });
  test("connecting cls → info tone", () => {
    const b = deriveConnBanner({ cls: "connecting", label: "连接中…", browserOnline: true, provisioning: false });
    expect(b).toEqual({ tone: "info", text: "连接中…" });
  });
  test("离线优先级高于 provisioning(两者同真时归因断网)", () => {
    const b = deriveConnBanner({ cls: "disconnected", label: "x", browserOnline: false, provisioning: true });
    expect(b?.text).toBe("网络已断开，恢复后自动重连");
  });
});

describe("onopenSetInitialStatus / bridge error", () => {
  test("non-empty offline queue shows 补发 not 已连接", () => {
    expect(onopenSetInitialStatus(3)).toEqual(["补发离线消息… (3)", "connecting"]);
    expect(onopenSetInitialStatus(0)).toEqual(["已连接", "connected"]);
  });
  test("normalize + friendly", () => {
    expect(normalizeBridgeErrorCode("ERR_INSUFFICIENT_CREDITS")).toBe("insufficient_credits");
    expect(friendlyBridgeErrorMessage("INSUFFICIENT_CREDITS")).toMatch(/余额不足/);
  });
});

// 模型权威 gate 的拒帧(bridge / egress;方案 §4 R3-m12)。此前这些码全落进"系统暂时不可用"
// 的通用兜底 —— 用户既不知道发生了什么,也不知道 config_changed 是**可原样重发**的。
describe("模型权威拒帧的用户向文案(MODEL_CONFIG_CHANGED_RETRY_TURN 等)", () => {
  test("MODEL_CONFIG_CHANGED_RETRY_TURN → 归一 + 明确告知可重发,且不是通用兜底", () => {
    expect(normalizeBridgeErrorCode("MODEL_CONFIG_CHANGED_RETRY_TURN")).toBe(
      "model_config_changed_retry_turn",
    );
    const msg = friendlyBridgeErrorMessage("MODEL_CONFIG_CHANGED_RETRY_TURN");
    expect(msg).toMatch(/模型配置/);
    expect(msg).toMatch(/重试|重发/); // 指向用户气泡下方既有的「重试」入口(原样重发)
    expect(msg).not.toMatch(/系统暂时不可用/);
  });

  test("MODEL_NOT_AVAILABLE / UNRESOLVED_AGENT_MODEL → 引导换模型,而非「稍后重试」", () => {
    expect(friendlyBridgeErrorMessage("MODEL_NOT_AVAILABLE")).toMatch(/模型/);
    expect(friendlyBridgeErrorMessage("MODEL_NOT_AVAILABLE")).not.toMatch(/系统暂时不可用/);
    expect(friendlyBridgeErrorMessage("UNRESOLVED_AGENT_MODEL")).toMatch(/选择模型/);
  });

  test("MODEL_AUTHORITY_UNAVAILABLE / MODEL_CATALOG_UNAVAILABLE → 稍后重试文案", () => {
    expect(friendlyBridgeErrorMessage("MODEL_AUTHORITY_UNAVAILABLE")).toMatch(/稍后/);
    expect(friendlyBridgeErrorMessage("MODEL_CATALOG_UNAVAILABLE")).toMatch(/稍后/);
  });

  test("配置变更/模型下架 = 预期业务态(不自动上报);catalog 不可用 = 基建故障(要上报)", () => {
    expect(EXPECTED_TURN_ERR_CODES.has("model_config_changed_retry_turn")).toBe(true);
    expect(EXPECTED_TURN_ERR_CODES.has("model_not_available")).toBe(true);
    expect(EXPECTED_TURN_ERR_CODES.has("model_authority_unavailable")).toBe(false);
    expect(EXPECTED_TURN_ERR_CODES.has("model_catalog_unavailable")).toBe(false);
  });
});

// friendlyBridgeErrorMessage 服务端 message 白名单透传(任务①/⑥)。
describe("friendlyBridgeErrorMessage · 服务端 message 白名单", () => {
  test("container_outdated(allowPublicServerMessage) 带合法 message → 透传服务端原因", () => {
    const msg = friendlyBridgeErrorMessage("container_outdated", "运行环境已升级到 v9，请刷新页面。");
    expect(msg).toBe("运行环境已升级到 v9，请刷新页面。");
  });

  test("container_outdated 带 JSON 形态 message → 回按码文案(不透传技术串)", () => {
    const msg = friendlyBridgeErrorMessage(
      "container_outdated",
      '{"error":"image_missing","status":503}',
    );
    expect(msg).not.toMatch(/image_missing|503|\{/);
    expect(msg).toMatch(/刷新页面/); // 按码文案仍指向「刷新」而非「重试」
  });

  test("非白名单码(rate_limited)即便带合法 message 也不透传 → 按码文案", () => {
    const msg = friendlyBridgeErrorMessage("rate_limited", "slow down please");
    expect(msg).not.toMatch(/slow down/);
    expect(msg).toMatch(/稍后|重试/);
  });

  test("model_capacity → 引导稍后重试或切换模型(新增码,非兜底)", () => {
    const msg = friendlyBridgeErrorMessage("model_capacity");
    expect(msg).not.toMatch(/系统暂时不可用/);
    expect(msg).toMatch(/切换|模型|重试/);
  });

  test("container_outdated 正文指向刷新页面(不是重试)", () => {
    expect(friendlyBridgeErrorMessage("container_outdated")).toMatch(/刷新页面/);
  });
});

// ═══════════════ applyTurnStatus retrying 软提示(任务③)═══════════════
function turnStatusFrame(over: AnyFrame): Parameters<typeof applyTurnStatus>[1] {
  return {
    type: "outbound.turn_status",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    ...over,
  } as unknown as Parameters<typeof applyTurnStatus>[1];
}

function turnUsageFrame(over: AnyFrame): Parameters<typeof applyTurnUsage>[1] {
  return {
    type: "outbound.turn_usage",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    clientMessageId: "u1",
    usage: { totalTokens: 1 },
    ...over,
  } as unknown as Parameters<typeof applyTurnUsage>[1];
}

function callUsageFrame(over: AnyFrame): Parameters<typeof applyCallUsage>[1] {
  return {
    type: "outbound.call_usage",
    sessionKey: "agent:main:webchat:dm:s1",
    channel: "webchat",
    peer: { id: "s1", kind: "dm" },
    clientMessageId: "u1",
    call: {
      callId: "a1-ccb-1",
      targetIds: ["tool-block-1"],
      usage: { totalTokens: 1 },
    },
    ...over,
  } as unknown as Parameters<typeof applyCallUsage>[1];
}

describe("applyTurnStatus retrying 判别联合", () => {
  test("status=retrying → _turnStatus 建模为 {kind,attempt,max,retryAt}", () => {
    const s = sess();
    const retryAt = Date.now() + 5000;
    applyTurnStatus(s, turnStatusFrame({ status: "retrying", retry: { attempt: 2, max: 3, delayMs: 5000, retryAt } }));
    expect(isRetryingTurnStatus(s._turnStatus)).toBe(true);
    expect(s._turnStatus).toEqual({ kind: "retrying", attempt: 2, max: 10, retryAt });
  });

  test("compacting 现状不变(字符串态)", () => {
    const s = sess();
    applyTurnStatus(s, turnStatusFrame({ status: "compacting" }));
    expect(s._turnStatus).toBe("compacting");
  });

  test("status=null 复位帧 → 清 retrying 软提示", () => {
    const s = sess();
    applyTurnStatus(s, turnStatusFrame({ status: "retrying", retry: { attempt: 1, max: 3, delayMs: 2000, retryAt: Date.now() + 2000 } }));
    expect(isRetryingTurnStatus(s._turnStatus)).toBe(true);
    applyTurnStatus(s, turnStatusFrame({ status: null }));
    expect(s._turnStatus).toBeNull();
  });

  test("null 帧丢失时,下一 attempt 的内容帧自动清 retrying(防粘住)", () => {
    const s = sess();
    s._sendingInFlight = true;
    applyTurnStatus(s, turnStatusFrame({ status: "retrying", retry: { attempt: 2, max: 3, delayMs: 3000, retryAt: Date.now() + 3000 } }));
    expect(isRetryingTurnStatus(s._turnStatus)).toBe(true);
    // 引擎在下一 attempt 产出真实文本内容(非 tail-only)→ 流恢复,软提示自动消解。
    applyOutboundMessage(
      s,
      msgFrame({ blocks: [{ kind: "text", text: "重试成功后的回复" }], frameSeq: 1 }),
      {},
    );
    expect(s._turnStatus).toBeNull();
  });

  test("tool_output_tail-only 帧不清 retrying(不是内容恢复)", () => {
    const s = sess();
    s._sendingInFlight = true;
    applyTurnStatus(s, turnStatusFrame({ status: "retrying", retry: { attempt: 2, max: 3, delayMs: 3000, retryAt: Date.now() + 3000 } }));
    applyOutboundMessage(
      s,
      msgFrame({ blocks: [{ kind: "tool_output_tail", blockId: "b1", tail: "x", totalBytes: 1 }], frameSeq: 1 }),
      {},
    );
    expect(isRetryingTurnStatus(s._turnStatus)).toBe(true);
  });

  test("终态 error 帧 → clearTurnTiming 清 _turnStatus", () => {
    const s = sess();
    s._sendingInFlight = true;
    s._activeClientMessageId = "u1";
    applyTurnStatus(s, turnStatusFrame({ status: "retrying", retry: { attempt: 3, max: 3, delayMs: 0, retryAt: Date.now() } }));
    applyOutboundError(s, {
      type: "outbound.error",
      sessionKey: "k",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      code: "model_capacity",
      message: "at capacity",
      clientMessageId: "u1",
      isFinal: false,
    } as never);
    expect(s._turnStatus).toBeNull();
  });
});

describe("applyTurnUsage 实时 token 权威快照", () => {
  test("上游暂无 exact usage 时按真实流式增量显示约数，exact 到达后重新锚定", () => {
    const s = sess();
    const user = addMessage(s, "user", "abcd", { id: "u1", status: "sent" });
    s._activeClientMessageId = user.id;
    s._sendingInFlight = true;

    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      clientMessageId: user.id,
      blocks: [{ kind: "thinking", text: "efgh" }],
    }));
    const first = s._liveTurnUsage?.usage.totalTokens ?? 0;
    expect(s._liveTurnUsage?.usage.estimated).toBe(true);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 2,
      clientMessageId: user.id,
      blocks: [{ kind: "text", text: "ijklmnop" }],
    }));
    const second = s._liveTurnUsage?.usage.totalTokens ?? 0;
    expect(second).toBeGreaterThan(first);

    applyTurnUsage(s, turnUsageFrame({
      frameSeq: 3,
      clientMessageId: user.id,
      usage: { totalTokens: 100, inputTokens: 90, outputTokens: 10 },
    }));
    expect(s._liveTurnUsage?.usage).toMatchObject({
      totalTokens: 100,
      inputTokens: 90,
      outputTokens: 10,
    });
    expect(s._liveTurnUsage?.usage.estimated).toBeUndefined();

    applyOutboundMessage(s, msgFrame({
      frameSeq: 4,
      clientMessageId: user.id,
      blocks: [{ kind: "text", text: "qrst" }],
    }));
    expect(s._liveTurnUsage?.usage).toMatchObject({
      totalTokens: 101,
      inputTokens: 90,
      outputTokens: 10,
      estimated: true,
    });
  });

  test("累计 tool input 快照只计算正向增量，重复 frameSeq 与跨 turn 帧不计", () => {
    const s = sess();
    const user = addMessage(s, "user", "run", { id: "u1", status: "sent" });
    s._activeClientMessageId = user.id;
    s._sendingInFlight = true;

    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      clientMessageId: user.id,
      blocks: [{
        kind: "tool_use",
        blockId: "tool-live",
        toolName: "Bash",
        partialJsonDelta: "{\"command\":\"echo",
        partialJsonOffset: 0,
        partial: true,
      }],
    }));
    const first = s._liveTurnUsage?.usage.totalTokens ?? 0;

    applyOutboundMessage(s, msgFrame({
      frameSeq: 2,
      clientMessageId: user.id,
      blocks: [{
        kind: "tool_use",
        blockId: "tool-live",
        toolName: "Bash",
        partialJsonDelta: "{\"command\":\"echo",
        partialJsonOffset: 0,
        partial: true,
      }],
    }));
    expect(s._liveTurnUsage?.usage.totalTokens).toBe(first);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 3,
      clientMessageId: user.id,
      blocks: [{
        kind: "tool_use",
        blockId: "tool-live",
        toolName: "Bash",
        inputJson: { command: "echo ok" },
        partial: false,
      }],
    }));
    const completed = s._liveTurnUsage?.usage.totalTokens ?? 0;
    expect(completed).toBeGreaterThanOrEqual(first);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 3,
      clientMessageId: user.id,
      blocks: [{ kind: "text", text: "duplicate" }],
    }));
    expect(s._liveTurnUsage?.usage.totalTokens).toBe(completed);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 4,
      clientMessageId: "other-turn",
      blocks: [{ kind: "text", text: "stale" }],
    }));
    expect(s._liveTurnUsage?.usage.totalTokens).toBe(completed);
  });

  test("只替换当前 exact turn，忽略 stale turn，并随终态清理", () => {
    const s = sess();
    s._activeClientMessageId = "u1";
    s._sendingInFlight = true;

    applyTurnUsage(s, turnUsageFrame({ frameSeq: 1, usage: { totalTokens: 128 } }));
    expect(s._liveTurnUsage).toMatchObject({
      clientMessageId: "u1",
      usage: { totalTokens: 128 },
    });

    applyTurnUsage(s, turnUsageFrame({
      frameSeq: 2,
      clientMessageId: "stale-turn",
      usage: { totalTokens: 999 },
    }));
    expect(s._liveTurnUsage?.usage.totalTokens).toBe(128);

    applyTurnUsage(s, turnUsageFrame({ frameSeq: 3, usage: { totalTokens: 256 } }));
    expect(s._liveTurnUsage?.usage.totalTokens).toBe(256);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 4,
      clientMessageId: "u1",
      blocks: [],
      isFinal: true,
    }));
    expect(s._liveTurnUsage).toBeUndefined();
  });

  test("tool-only turn 的 final durable meta 接棒实时快照", () => {
    const s = sess();
    const user = addMessage(s, "user", "run", { id: "u1", status: "sent" });
    s._activeClientMessageId = user.id;
    s._sendingInFlight = true;
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      clientMessageId: user.id,
      blocks: [{
        kind: "tool_use",
        blockId: "tool-usage",
        toolName: "Bash",
        inputJson: { command: "pwd" },
        partial: false,
      }],
    }));
    expect(s._liveTurnUsage?.usage).toMatchObject({
      estimated: true,
    });
    applyTurnUsage(s, turnUsageFrame({
      frameSeq: 2,
      clientMessageId: user.id,
      usage: { totalTokens: 40 },
    }));
    applyOutboundMessage(s, msgFrame({
      frameSeq: 3,
      clientMessageId: user.id,
      blocks: [],
      isFinal: true,
      meta: { totalTokens: 42, inputTokens: 35, outputTokens: 7 },
    }));

    const tool = s.messages.find((message) => message.role === "tool");
    expect(tool?.usage).toMatchObject({
      totalTokens: 42,
      inputTokens: 35,
      outputTokens: 7,
    });
    expect(s._liveTurnUsage).toBeUndefined();
  });
});

describe("applyCallUsage 每张卡片调用 token 快照", () => {
  test("按 durable blockId 绑定工具卡并实时替换同一次调用的绝对值", () => {
    const s = sess();
    s._activeClientMessageId = "u1";
    const tool = addMessage(s, "tool", "", {
      id: "tool-message-1",
      blockId: "tool-block-1",
      toolName: "Bash",
    });
    s._blockIdToMsgId?.set("tool-block-1", tool.id);

    applyCallUsage(s, callUsageFrame({
      frameSeq: 1,
      call: {
        callId: "a1-ccb-1",
        targetIds: ["tool-block-1"],
        usage: { totalTokens: 128 },
      },
    }));
    expect(tool._callUsage).toEqual({
      callId: "a1-ccb-1",
      targetIds: ["tool-block-1"],
      usage: { totalTokens: 128 },
    });

    applyCallUsage(s, callUsageFrame({
      frameSeq: 2,
      call: {
        callId: "a1-ccb-1",
        targetIds: ["tool-block-1"],
        usage: { totalTokens: 2_048 },
      },
    }));
    expect(tool._callUsage?.usage.totalTokens).toBe(2_048);
  });

  test("同一次调用的并行卡片共享完整 exact 值，不做伪均分", () => {
    const s = sess();
    s._activeClientMessageId = "u1";
    const first = addMessage(s, "thinking", "分析一", { id: "thinking-1" });
    const second = addMessage(s, "thinking", "分析二", { id: "thinking-2" });
    applyCallUsage(s, callUsageFrame({
      frameSeq: 1,
      call: {
        callId: "a1-codex-1",
        targetIds: [first.id, second.id],
        usage: { totalTokens: 123_456 },
      },
    }));
    expect(first._callUsage?.usage.totalTokens).toBe(123_456);
    expect(second._callUsage).toEqual(first._callUsage);
  });

  test("按 plan blockId 贯穿绑定实时 plan 卡，而非只在刷新后恢复", () => {
    const s = sess();
    s._activeClientMessageId = "u1";
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      clientMessageId: "u1",
      blocks: [{
        kind: "plan",
        blockId: "codex-plan-turn-1",
        explanation: "执行计划",
        steps: [{ step: "实现", status: "inProgress" }],
      }],
    }));
    const plan = s.messages.find((message) => message.role === "plan");
    expect(plan?.id).not.toBe("codex-plan-turn-1");

    applyCallUsage(s, callUsageFrame({
      frameSeq: 2,
      call: {
        callId: "a1-codex-1",
        targetIds: ["codex-plan-turn-1"],
        usage: { totalTokens: 12_345 },
      },
    }));
    expect(plan?._callUsage).toEqual({
      callId: "a1-codex-1",
      targetIds: ["codex-plan-turn-1"],
      usage: { totalTokens: 12_345 },
    });
  });

  test("忽略跨 turn 与重复 frameSeq 的归属帧", () => {
    const s = sess();
    s._activeClientMessageId = "u1";
    const tool = addMessage(s, "tool", "", { id: "tool-block-1", toolName: "Bash" });
    applyCallUsage(s, callUsageFrame({
      frameSeq: 1,
      call: {
        callId: "a1-ccb-1",
        targetIds: [tool.id],
        usage: { totalTokens: 64 },
      },
    }));
    applyCallUsage(s, callUsageFrame({
      frameSeq: 1,
      call: {
        callId: "a1-ccb-1",
        targetIds: [tool.id],
        usage: { totalTokens: 999 },
      },
    }));
    applyCallUsage(s, callUsageFrame({
      frameSeq: 2,
      clientMessageId: "other-turn",
      call: {
        callId: "a1-ccb-2",
        targetIds: [tool.id],
        usage: { totalTokens: 777 },
      },
    }));
    expect(tool._callUsage?.usage.totalTokens).toBe(64);
  });
});

describe("findOrCreateStreamingRow (§9 canonical id upsert)", () => {
  test("rebinds to existing same-id+role row", () => {
    const rows: ChatMessage[] = [{ id: "srv-1", role: "assistant", text: "x", ts: 0 }];
    const created = vi.fn();
    const r = findOrCreateStreamingRow(rows, "assistant", "srv-1", (o) => {
      created();
      return { id: o.id ?? "new", role: "assistant", text: "", ts: 0 } as ChatMessage;
    });
    expect(r).toBe(rows[0]);
    expect(created).not.toHaveBeenCalled();
  });
});

// ═══════════════ reducer: §7/§9/§11 ═══════════════
describe("§11 stale 守卫 —— server 域截止 + teardown 时间窗", () => {
  test("teardown 时间窗过期后,非 final 帧正常渲染并复活发送态(多端新 turn 不被无界压制)", () => {
    const s = sess();
    s._localTeardownAt = Date.now() - 4 * 60_000; // stop 已过 4 分钟 > 3 分钟窗口
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, ts: Date.now() - 1000, blocks: [{ kind: "text", text: "新一轮", messageId: "srv-9" }] }),
    );
    expect(s.messages.some((m) => m.text === "新一轮")).toBe(true);
    expect(s._sendingInFlight).toBe(true);
  });

  test("teardown 时间窗内,旧 turn 非 final 晚到帧仍被压制", () => {
    const s = sess();
    s._localTeardownAt = Date.now() - 10_000;
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, ts: Date.now(), blocks: [{ kind: "text", text: "晚到", messageId: "srv-9" }] }),
    );
    expect(s.messages.some((m) => m.text === "晚到")).toBe(false);
    expect(s._sendingInFlight).toBeFalsy();
  });

  test("客户端时钟快于 server:reset 后新帧按 server 域截止放行,真 stale 帧仍拒", () => {
    const s = sess();
    // 模拟 server 时钟刻度远落后于客户端:reset 前见过的帧 server ts=1000。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, ts: 1_000, isFinal: true, blocks: [{ kind: "text", text: "旧轮", messageId: "srv-1" }] }),
    );
    resetReplyTracker(s); // stop/switch:_trackerResetAt=Date.now()(客户端钟,远大于 server 刻度)
    expect(s._trackerResetServerTs).toBe(1_000);
    // 新一轮:server ts=1500 > 截止 1000 → 放行。旧跨域实现会因 1500 < _trackerResetAt 整轮误杀。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 2, ts: 1_500, blocks: [{ kind: "text", text: "新轮", messageId: "srv-2" }] }),
    );
    expect(s.messages.some((m) => m.text === "新轮")).toBe(true);
    // 真 stale:server ts=900 ≤ 1000 → 拒(final 与非 final 同判)。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 3, ts: 900, blocks: [{ kind: "text", text: "stale", messageId: "srv-3" }] }),
    );
    expect(s.messages.some((m) => m.text === "stale")).toBe(false);
  });
});

describe("applyOutboundMessage (§3/§7/§9/§11)", () => {
  test("text streaming accumulates into one assistant row", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "Hel", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "text", text: "lo", messageId: "srv-1" }] }));
    const asst = s.messages.filter((m) => m.role === "assistant");
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("Hello");
    expect(asst[0].id).toBe("srv-1");
  });

  test("frameSeq dedupe drops replayed dup (no double text)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "A", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "A", messageId: "srv-1" }] }));
    expect(s.messages.filter((m) => m.role === "assistant")[0].text).toBe("A");
  });

  test("per-sessionKey cursors are independent (multi-container parallel streams)", () => {
    const s = sess();
    // A 容器推到 frameSeq 5 并收尾（清流式指针）。
    applyOutboundMessage(s, msgFrame({ sessionKey: "agent:a:webchat:dm:s1", frameSeq: 5, isFinal: true, ts: 9e12, blocks: [{ kind: "text", text: "A", messageId: "srv-a" }] }));
    // B 容器从 frameSeq 1 起：用全局单游标会被 A 的 5 当 dup 丢掉；per-key 下必须被处理。
    applyOutboundMessage(s, msgFrame({ sessionKey: "agent:b:webchat:dm:s1", frameSeq: 1, blocks: [{ kind: "text", text: "B", messageId: "srv-b" }] }));
    expect(s.messages.find((m) => m.id === "srv-a")?.text).toBe("A");
    expect(s.messages.find((m) => m.id === "srv-b")?.text).toBe("B");
  });

  test("canonical id upsert across text→tool→text (no duplicate row)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "part1 ", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Read", blockId: "t1", partial: false, inputJson: {} }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "text", text: "part2", messageId: "srv-1" }] }));
    const asst = s.messages.filter((m) => m.role === "assistant" && m.id === "srv-1");
    expect(asst).toHaveLength(1);
    expect(asst[0].text).toBe("part1 part2");
  });

  test("native goal notifications update one stable platform card instead of spamming turns", () => {
    const s = sess();
    const platformGoalId = "11111111-1111-4111-8111-111111111111";
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      blocks: [{
        kind: "goal",
        blockId: "codex-turn-1",
        objective: "完成迁移",
        status: "active",
        tokensUsed: 10,
        platformGoalId,
        platformStateRevision: 1,
      }],
    }));
    applyOutboundMessage(s, msgFrame({
      frameSeq: 2,
      blocks: [{
        kind: "goal",
        blockId: "codex-turn-2",
        objective: "完成迁移并验证",
        status: "paused",
        tokensUsed: 25,
        platformGoalId,
        platformStateRevision: 2,
      }],
    }));
    const goals = s.messages.filter((m) => m.role === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      text: "完成迁移并验证",
      blockId: `platform-goal-${platformGoalId}`,
      goalStatus: "paused",
      tokensUsed: 25,
      platformStateRevision: 2,
    });
  });

  test("hydrated per-turn goal rows collapse to the latest stable platform card", () => {
    const s = sess();
    const platformGoalId = "11111111-1111-4111-8111-111111111111";
    addMessage(s, "goal", "old", {
      blockId: "codex-goal-turn-1",
      platformGoalId,
      platformStateRevision: 1,
      goalStatus: "active",
      updatedAt: 10,
    });
    addMessage(s, "goal", "latest", {
      blockId: "codex-goal-turn-2",
      platformGoalId,
      platformStateRevision: 2,
      goalStatus: "paused",
      updatedAt: 20,
    });
    normalizeGoalCards(s);
    expect(s.messages.filter((message) => message.role === "goal")).toHaveLength(1);
    expect(s.messages.find((message) => message.role === "goal")).toMatchObject({
      text: "latest",
      blockId: `platform-goal-${platformGoalId}`,
      platformStateRevision: 2,
      goalStatus: "paused",
    });
  });

  test("F6 hydrate 折叠后目标卡固定在最早槽位（位置 min、内容 max），与实时一致", () => {
    const s = sess();
    const platformGoalId = "22222222-2222-4222-8222-222222222222";
    // 交错非目标消息以观测位置：user → goal(rev1,anchor) → assistant → goal(rev2,winner)。
    addMessage(s, "user", "u-before");
    const anchor = addMessage(s, "goal", "old", {
      blockId: "codex-goal-turn-1",
      platformGoalId,
      platformStateRevision: 1,
      goalStatus: "active",
      updatedAt: 10,
    });
    addMessage(s, "assistant", "a-mid");
    addMessage(s, "goal", "latest", {
      blockId: "codex-goal-turn-2",
      platformGoalId,
      platformStateRevision: 2,
      goalStatus: "paused",
      updatedAt: 20,
    });
    normalizeGoalCards(s);

    const goals = s.messages.filter((m) => m.role === "goal");
    expect(goals).toHaveLength(1);
    // 位置 min：卡片留在最早槽位（user 之后、assistant 之前），不跳到「最后更新 turn」的位置。
    expect(s.messages.map((m) => m.role)).toEqual(["user", "goal", "assistant"]);
    // 内容 max：取最高修订。
    expect(goals[0]).toMatchObject({
      text: "latest",
      blockId: `platform-goal-${platformGoalId}`,
      platformStateRevision: 2,
      goalStatus: "paused",
    });
    // 槽位 id 稳定（沿用最早 anchor 卡，对齐实时「首次创建的持久对象就地更新」）。
    expect(goals[0].id).toBe(anchor.id);
  });

  test("goal snapshot merge rejects REST/WS regression and accepts monotonic usage", () => {
    const current = {
      sessionId: "s1",
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "ship",
      status: "active" as const,
      tokenBudget: 100,
      creditBudget: "100",
      tokensUsed: 20,
      creditsUsed: "30",
      timeUsedSeconds: 10,
      stateRevision: 2,
      snapshotRevision: 5,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      statusChangedAt: "2026-07-16T00:00:00.000Z",
    };
    expect(shouldApplyGoalSnapshot(current, { ...current, stateRevision: 1, snapshotRevision: 99 })).toBe(false);
    expect(shouldApplyGoalSnapshot(current, { ...current, snapshotRevision: 4, tokensUsed: 999 })).toBe(false);
    expect(shouldApplyGoalSnapshot(current, { ...current, timeUsedSeconds: 9 })).toBe(false);
    expect(shouldApplyGoalSnapshot(current, { ...current, timeUsedSeconds: 11 })).toBe(true);
    expect(shouldApplyGoalSnapshot(current, null)).toBe(false);
    expect(shouldApplyGoalSnapshot(current, {
      ...current,
      goalId: "22222222-2222-4222-8222-222222222222",
      stateRevision: 3,
    })).toBe(true);
  });

  test("tool partial→final: partialJson seeded then cleared on final", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: '{"a"', partialJsonOffset: 0 }] }));
    let tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBe('{"a"');
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: ":1}", partialJsonOffset: 4 }] }));
    tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBe('{"a":1}');
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: false, inputJson: { a: 1 } }] }));
    tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBeUndefined();
    expect(tool?.inputJson).toEqual({ a: 1 });
    expect(tool?._partial).toBe(false);
  });

  test("Codex fileChange cumulative snapshots update one live tool card in place", () => {
    const s = sess();
    const firstChanges = [{ path: "/tmp/live.ts", kind: { type: "update" }, diff: "-old\n+new" }];
    const latestChanges = [{ path: "/tmp/live.ts", kind: { type: "update" }, diff: "-old\n+new\n+more" }];
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      blocks: [{
        kind: "tool_use",
        toolName: "Edit",
        blockId: "patch-live-1",
        messageId: "srv-tool-patch-live-1",
        partial: true,
        inputJson: { file_path: "/tmp/live.ts", kind: "update", changes: firstChanges },
      }],
    }));
    const first = s.messages.find((m) => m.role === "tool" && m.blockId === "patch-live-1");
    expect(first?.id).toBe("srv-tool-patch-live-1");
    expect(first?._partial).toBe(true);
    expect(first?._inputRevision).toBe(1);
    const firstSignature = messageSignature(first!, { isLast: true, sending: true });

    applyOutboundMessage(s, msgFrame({
      frameSeq: 2,
      blocks: [{
        kind: "tool_use",
        toolName: "Edit",
        blockId: "patch-live-1",
        partial: true,
        inputJson: { file_path: "/tmp/live.ts", kind: "update", changes: latestChanges },
      }],
    }));
    const cards = s.messages.filter((m) => m.role === "tool" && m.blockId === "patch-live-1");
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(first?.id);
    expect(cards[0]._inputRevision).toBe(2);
    expect(messageSignature(cards[0], { isLast: true, sending: true })).not.toBe(firstSignature);
    expect(cards[0].inputJson).toEqual({
      file_path: "/tmp/live.ts",
      kind: "update",
      changes: latestChanges,
    });
    expect(cards[0]._partial).toBe(true);
  });

  test("delegate child structured snapshots update one tool and both child/parent signatures", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      blocks: [{
        kind: "tool_use",
        toolName: "delegate_task",
        blockId: "delegate-live-patch",
        partial: false,
        inputJson: { agentId: "hidden-reviewer", goal: "stream a patch" },
      }],
    }));
    applyOutboundMessage(s, msgFrame({
      frameSeq: 2,
      blocks: [{
        kind: "delegate_progress",
        runId: "delegate-live-patch-run",
        agentId: "hidden-reviewer",
        goal: "stream a patch",
        phase: "start",
        text: "开始",
      }],
    }));
    applyOutboundMessage(s, msgFrame({
      frameSeq: 3,
      blocks: [{
        kind: "delegate_progress",
        runId: "delegate-live-patch-run",
        agentId: "hidden-reviewer",
        phase: "tool",
        block: {
          kind: "tool_use",
          blockId: "child-live-patch",
          toolName: "Write",
          partial: true,
          inputJson: {
            file_path: "/tmp/child.ts",
            kind: "add",
            changes: [{ path: "/tmp/child.ts", kind: { type: "add" }, diff: "first" }],
          },
        },
      }],
    }));

    const group = s.messages.find((m) => m.role === "agent-group")!;
    const child = group.childBlocks!.find((block) => block.blockId === "child-live-patch")!;
    const firstChildSignature = childSignature(child);
    const firstParentSignature = messageSignature(group, { isLast: true, sending: true });
    expect(child._inputRevision).toBe(1);

    applyOutboundMessage(s, msgFrame({
      frameSeq: 4,
      blocks: [{
        kind: "delegate_progress",
        runId: "delegate-live-patch-run",
        agentId: "hidden-reviewer",
        phase: "tool",
        block: {
          kind: "tool_use",
          blockId: "child-live-patch",
          toolName: "Write",
          partial: true,
          inputJson: {
            file_path: "/tmp/child.ts",
            kind: "add",
            changes: [{ path: "/tmp/child.ts", kind: { type: "add" }, diff: "first\nsecond" }],
          },
        },
      }],
    }));

    const latestChildren = group.childBlocks!.filter((block) => block.blockId === "child-live-patch");
    expect(latestChildren).toHaveLength(1);
    expect(latestChildren[0]).toBe(child);
    expect(latestChildren[0]._inputRevision).toBe(2);
    expect(childSignature(latestChildren[0])).not.toBe(firstChildSignature);
    expect(messageSignature(group, { isLast: true, sending: true })).not.toBe(firstParentSignature);
    expect(latestChildren[0].inputJson).toMatchObject({
      changes: [{ diff: "first\nsecond" }],
    });
  });

  test("tool partial offset mismatch drops buffer (no torn JSON)", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: '{"a"', partialJsonOffset: 0 }] }));
    // wrong offset → drop
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_use", toolName: "Edit", blockId: "t1", partial: true, partialJsonDelta: "X", partialJsonOffset: 99 }] }));
    const tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.partialJson).toBeUndefined();
  });

  test("tool_output_tail monotonic guard drops regressed totalBytes", () => {
    const s = sess();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "t1", partial: false, inputJson: {} }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "100", totalBytes: 100, truncatedHead: false }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 3, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "50", totalBytes: 50, truncatedHead: false }] }));
    const tool = s.messages.find((m) => m.role === "tool" && m.blockId === "t1");
    expect(tool?.bashTail?.totalBytes).toBe(100);
  });

  // C3:turn 终态后晚到的纯 tool_output_tail 帧(bg bash 每秒一条尾巴刷新)只做帧计活 + bash 卡原位
  // 刷新,其余生命周期信号(复活发送态/绑 reply tracker/标 user read/onLiveFrame)一律短路。
  test("tail-only 帧短路生命周期:不复活/不绑 tracker/不标 user read/不触发 onLiveFrame(但 bash 卡原位刷新)", () => {
    const s = sess();
    const onLiveFrame = vi.fn();
    // 旧 turn 留下的 Bash 工具卡。
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "t1", partial: false, inputJson: {} }] }));
    // 模拟旧 turn 已收尾 + 新 turn 的用户行刚发出(尚未回复)。
    s._sendingInFlight = false;
    s._replyingToMsgId = null;
    const u = addMessage(s, "user", "新问题", { status: "sent" });
    // 旧 turn 的 bg bash tail 晚到(纯 tool_output_tail 帧)——与新 turn 用户行重叠。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "chunk", totalBytes: 5, truncatedHead: false }] }),
      { onLiveFrame },
    );
    expect(s._sendingInFlight).toBe(false); // 不复活发送态
    expect(s._replyingToMsgId).toBeFalsy(); // 不绑 reply tracker
    expect(u.status).toBe("sent"); // 新 user 行不被错标 read
    expect(onLiveFrame).not.toHaveBeenCalled(); // 不发 live 生命周期信号
    expect(s.messages.find((m) => m.blockId === "t1")?.bashTail?.tail).toBe("chunk"); // 但 bash 卡原位刷新
  });

  test("活跃 turn 中的 tail-only 帧也不触发 onLiveFrame(帧仍被处理:bash 卡刷新)", () => {
    const s = sess();
    const onLiveFrame = vi.fn();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "t1", partial: false, inputJson: {} }] }));
    s._sendingInFlight = true; // turn 仍在进行(长 bash 只发 tail)
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 2, blocks: [{ kind: "tool_output_tail", toolUseBlockId: "t1", tail: "更多", totalBytes: 9, truncatedHead: false }] }),
      { onLiveFrame },
    );
    expect(onLiveFrame).not.toHaveBeenCalled(); // tail-only 不发 onLiveFrame
    expect(s._sendingInFlight).toBe(true); // 活跃态不受影响
    expect(s.messages.find((m) => m.blockId === "t1")?.bashTail?.tail).toBe("更多"); // 帧仍被处理(块循环原位刷新)
  });

  test("混合帧(tail + text)行为不变:复活发送态 + 触发 onLiveFrame + 绑 tracker + 标 user read", () => {
    const s = sess();
    const onLiveFrame = vi.fn();
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "tool_use", toolName: "Bash", blockId: "t1", partial: false, inputJson: {} }] }));
    s._sendingInFlight = false;
    s._replyingToMsgId = null;
    const u = addMessage(s, "user", "新问题", { status: "sent" });
    // tail + text 混合:text 代表模型确有新生成 → 生命周期一律照旧。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 2, blocks: [
        { kind: "tool_output_tail", toolUseBlockId: "t1", tail: "chunk", totalBytes: 5, truncatedHead: false },
        { kind: "text", text: "继续", messageId: "srv-x" },
      ] }),
      { onLiveFrame },
    );
    expect(s._sendingInFlight).toBe(true); // 复活
    expect(onLiveFrame).toHaveBeenCalledWith(s); // 生命周期信号照旧
    expect(s._replyingToMsgId).toBe(u.id); // 绑 tracker
    expect(u.status).toBe("read"); // 标 read
  });

  // C2:采用引擎 messageId(srv- 前缀)的 live 生成行也应被盖上当前活跃轮的 _clientMessageId,
  // 否则 finalize 后无法按 _clientMessageId 精确去重(与 server 分段副本并存重复渲染)。
  test("采用引擎 messageId(srv-*)的 live assistant 行也盖 _clientMessageId", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent" });
    s._activeClientMessageId = u.id;
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "答", messageId: "srv-peer-main-t1" }] }));
    const asst = s.messages.find((m) => m.id === "srv-peer-main-t1");
    expect(asst?.role).toBe("assistant");
    expect(asst?._clientMessageId).toBe(u.id);
  });

  test("§11 stale-final 早于最近 turn 边界的 server 截止 → 丢弃(不误 teardown)", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1000 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    // 上一轮 turn 边界(resetReplyTracker)定格的 server 域截止 = 1000。
    s._lastServerTs = 1000;
    s._trackerResetServerTs = 1000;
    // server ts=500 ≤ 截止 → stale late final → 丢弃,不误 teardown。
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, isFinal: true, ts: 500, blocks: [] }));
    expect(s._sendingInFlight).toBe(true); // dropped → no teardown
  });

  test("§11 客户端钟快于 server:本轮合法 final 不被吞 → 正常 teardown(消除跨钟域卡「回复中」)", () => {
    const s = sess();
    // 设备钟比 server 快 5min:user 行客户端 ts 很大(addMessage 用 Date.now())。
    const u = addMessage(s, "user", "hi", { status: "sent", ts: Date.now() + 5 * 60_000 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    // server 域 turn 边界截止只有 1000(远小于客户端钟)。
    s._lastServerTs = 1000;
    s._trackerResetServerTs = 1000;
    // 本轮答案帧(server ts=1400 > 1000 → 放行,绑定并流出内容)。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, ts: 1400, blocks: [{ kind: "text", text: "答", messageId: "srv-1" }] }),
    );
    // 本轮合法 final(server ts=1500 > 截止 1000)。旧跨钟域实现会因 1500 < boundMsg.ts(客户端
    // +5min)误判 stale 丢弃 → _sendingInFlight 永不清 → 永久卡「回复中」。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 2, isFinal: true, ts: 1500, blocks: [], meta: { stopReason: "end_turn" } }),
    );
    expect(s._sendingInFlight).toBe(false); // 正常收尾
    expect(s.messages.some((m) => m.text === "答")).toBe(true);
  });

  test("reload 后新非 final 内容帧会在 guard 之后恢复 _sendingInFlight", () => {
    const s = sess();
    const onLiveFrame = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "仍在输出", messageId: "srv-1" }] }),
      { onLiveFrame },
    );
    expect(s._sendingInFlight).toBe(true);
    expect(onLiveFrame).toHaveBeenCalledWith(s);
  });

  test("stale/agent-switch guard 拦截的非 final 帧不会恢复 _sendingInFlight", () => {
    const stale = sess();
    stale._lastFrameSeqByKey = { "agent:main:webchat:dm:s1": 5 };
    const onLiveFrame = vi.fn();
    applyOutboundMessage(
      stale,
      msgFrame({ frameSeq: 4, blocks: [{ kind: "text", text: "旧帧", messageId: "old" }] }),
      { onLiveFrame },
    );
    expect(stale._sendingInFlight).not.toBe(true);
    expect(onLiveFrame).not.toHaveBeenCalled();

    const reset = sess();
    reset._trackerResetAt = Date.now();
    applyOutboundMessage(
      reset,
      msgFrame({
        frameSeq: 1,
        ts: reset._trackerResetAt - 1,
        blocks: [{ kind: "text", text: "stop 后迟到", messageId: "late" }],
      }),
      { onLiveFrame },
    );
    expect(reset._sendingInFlight).not.toBe(true);
    expect(reset.messages).toHaveLength(0);

    const localReset = sess();
    localReset._trackerResetAt = Date.now();
    localReset._localTeardownAt = localReset._trackerResetAt;
    applyOutboundMessage(
      localReset,
      msgFrame({
        frameSeq: 1,
        ts: localReset._trackerResetAt + 1,
        blocks: [{ kind: "text", text: "stop 后才 stamp 的迟到帧", messageId: "late-stamped" }],
      }),
      { onLiveFrame },
    );
    expect(localReset._sendingInFlight).not.toBe(true);
    expect(localReset.messages).toHaveLength(0);

    const localResetNoTs = sess();
    localResetNoTs._localTeardownAt = Date.now();
    applyOutboundMessage(
      localResetNoTs,
      msgFrame({ frameSeq: 1, ts: undefined, blocks: [{ kind: "text", text: "无 ts 迟到帧", messageId: "late-no-ts" }] }),
      { onLiveFrame },
    );
    expect(localResetNoTs._sendingInFlight).not.toBe(true);
    expect(localResetNoTs.messages).toHaveLength(0);

    const cron = sess();
    cron._localTeardownAt = Date.now();
    onLiveFrame.mockClear();
    applyOutboundMessage(
      cron,
      msgFrame({
        frameSeq: 1,
        cronJob: { label: "定时推送" },
        blocks: [{ kind: "text", text: "合法 cron 推送", messageId: "cron-1" }],
      }),
      { onLiveFrame },
    );
    expect(cron.messages.some((m) => m.text === "合法 cron 推送" && m.cronPush)).toBe(true);
    expect(cron._sendingInFlight).not.toBe(true);
    expect(onLiveFrame).not.toHaveBeenCalled();

    const switched = sess();
    switched._agentSwitchedAt = Date.now();
    applyOutboundMessage(
      switched,
      msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "旧 agent", messageId: "old-agent" }] }),
      { onLiveFrame },
    );
    expect(switched._sendingInFlight).not.toBe(true);
    expect(switched.messages).toHaveLength(0);
  });

  test("isFinal teardown clears _sendingInFlight + streaming pointers", () => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    applyOutboundMessage(s, msgFrame({ frameSeq: 1, blocks: [{ kind: "text", text: "ok", messageId: "srv-1" }] }));
    applyOutboundMessage(s, msgFrame({ frameSeq: 2, isFinal: true, ts: 999999999999, blocks: [], meta: { stopReason: "end_turn" } }));
    expect(s._sendingInFlight).toBe(false);
    expect(s._streamingAssistant).toBeNull();
  });

  test("every live Agent process role is stamped with its owning user turn", () => {
    const s = sess();
    const owner = "cm-owned-process";
    addMessage(s, "user", "run", { id: owner, status: "sent" });
    s._activeClientMessageId = owner;
    s._sendingInFlight = true;
    applyOutboundMessage(s, msgFrame({
      frameSeq: 1,
      clientMessageId: owner,
      blocks: [
        { kind: "text", text: "answer", messageId: "live-answer" },
        { kind: "thinking", text: "thought", messageId: "live-thinking" },
        { kind: "plan", blockId: "owned-plan", text: "plan", steps: [] },
        { kind: "goal", blockId: "owned-goal", objective: "goal", status: "active" },
        { kind: "tool_use", blockId: "owned-tool", toolName: "Bash", inputJson: { command: "true" } },
        { kind: "tool_use", blockId: "owned-agent", toolName: "Agent", inputJson: { description: "review" } },
        {
          kind: "delegate_progress",
          runId: "owned-run",
          agentId: "reviewer",
          phase: "start",
          goal: "review",
          text: "started",
        },
      ],
    }));

    const process = s.messages.filter((message) =>
      message.role !== "user" && message.role !== "permission" && message.role !== "system");
    expect(new Set(process.map((message) => message.role))).toEqual(new Set([
      "assistant", "thinking", "plan", "goal", "tool", "agent-group", "delegate-progress",
    ]));
    expect(process.every((message) => message._turnOwnerId === owner)).toBe(true);
  });

  test("empty turn (end_turn, no answer) schedules ONE auto-continue", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    const scheduleAutoContinue = vi.fn();
    const effects: FrameEffects = { scheduleAutoContinue };
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 999999999999, blocks: [{ kind: "thinking", text: "hmm", messageId: "srv-t" }], meta: { stopReason: "end_turn" } }),
      effects,
    );
    expect(scheduleAutoContinue).toHaveBeenCalledTimes(1);
    expect(scheduleAutoContinue.mock.calls[0][1]).toBe(u.id);
  });

  test("empty turn (max_tokens, no auto) inserts a notice", () => {
    const s = sess();
    const u = addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 999999999999, blocks: [], meta: { stopReason: "max_tokens" } }),
      {},
    );
    expect(s.messages.some((m) => m._emptyTurn)).toBe(true);
  });

  test("delegate_progress start before delegate_task tool_use is adopted into one agent-group", () => {
    const s = sess();
    const user = addMessage(s, "user", "开始委派", { id: "u-delegate-live", status: "sent" });
    s._activeClientMessageId = user.id;
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        clientMessageId: user.id,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-1",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(1);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        clientMessageId: user.id,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-1",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-1");
    expect(groups[0]._turnOwnerId).toBe(user.id);
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
  });

  test("delegate usage is absolute per exact child run and survives standalone adoption", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [{
          kind: "delegate_progress",
          runId: "visible-run",
          agentId: "hidden-reviewer",
          phase: "start",
          goal: "审查草稿",
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{
          kind: "delegate_progress",
          runId: "visible-run",
          usageRunId: "nested-run",
          agentId: "coding-assistant",
          phase: "usage",
          usage: { totalTokens: 10 },
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [{
          kind: "delegate_progress",
          runId: "visible-run",
          usageRunId: "nested-run",
          agentId: "coding-assistant",
          phase: "usage",
          usage: { totalTokens: 25 },
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [{
          kind: "delegate_progress",
          runId: "visible-run",
          usageRunId: "visible-run",
          agentId: "hidden-reviewer",
          phase: "usage",
          usage: { totalTokens: 40 },
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 5,
        blocks: [{
          kind: "tool_use",
          toolName: "delegate_task",
          blockId: "tool-usage-adopt",
          partial: false,
          inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
        }],
      }),
    );

    const group = s.messages.find((message) => message.role === "agent-group");
    expect(group?._delegateUsageByRun).toEqual({
      "nested-run": { totalTokens: 25 },
      "visible-run": { totalTokens: 40 },
    });
    expect(s.messages.some((message) => message.role === "delegate-progress")).toBe(false);
  });

  test("fan-out delegate_tasks: 各 runId 物化独立 agent-group(非 delegate-progress), server 行折叠不重复", () => {
    const s = sess();
    // 队长复数 fan-out tool_use —— **不转组**,保持 role:"tool" 作紧凑头部。
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "mcp__openclaude-memory__delegate_tasks",
            blockId: "tool-fanout",
            partial: false,
            inputJson: {
              tasks: [
                { agentId: "coding-assistant", goal: "任务A" },
                { agentId: "office-assistant", goal: "任务B" },
              ],
            },
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(0);

    // 两个子任务各自 start(独立 runId)。
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-a", agentId: "coding-assistant", phase: "start", goal: "任务A", text: "开始 A" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [{ kind: "delegate_progress", runId: "dlg-b", agentId: "office-assistant", phase: "start", goal: "任务B", text: "开始 B" }],
      }),
    );

    // 兜底路径产出 agent-group(非 delegate-progress standalone)。
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g._delegateRunId).sort()).toEqual(["dlg-a", "dlg-b"]);
    expect(groups.map((g) => g.text).sort()).toEqual(["任务A", "任务B"]);

    // 终态帧:A 完成 / B 失败,分别落到各自的组。
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 4, blocks: [{ kind: "delegate_progress", runId: "dlg-a", agentId: "coding-assistant", phase: "done", text: "A 完成" }] }),
    );
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 5, blocks: [{ kind: "delegate_progress", runId: "dlg-b", agentId: "office-assistant", phase: "error", text: "B 失败" }] }),
    );
    const ga = s.messages.find((m) => m._delegateRunId === "dlg-a")!;
    const gb = s.messages.find((m) => m._delegateRunId === "dlg-b")!;
    expect(ga._completed).toBe(true);
    expect(ga._isError).toBeFalsy();
    expect(ga._resultPreview).toBe("A 完成");
    expect(gb._completed).toBe(true);
    expect(gb._isError).toBe(true);

    // turn 末 server-authored agent-group 骨架行(同 runId)到达 → normalizeDelegateCards 按 runId 折叠,
    // 本地富卡 local-wins,不产生第三/四张卡。
    s.messages.push({
      id: "srv-a",
      role: "agent-group",
      text: "任务A",
      ts: Date.now(),
      _source: "server",
      _delegate: true,
      runId: "dlg-a",
      _delegateAgentId: "coding-assistant",
      _delegateGoal: "任务A",
      _completed: true,
      _delegateStatus: "ok",
    } as ChatMessage);
    s.messages.push({
      id: "srv-b",
      role: "agent-group",
      text: "任务B",
      ts: Date.now(),
      _source: "server",
      _delegate: true,
      runId: "dlg-b",
      _delegateAgentId: "office-assistant",
      _delegateGoal: "任务B",
      _completed: true,
      _delegateStatus: "failed",
    } as ChatMessage);
    normalizeDelegateCards(s);
    const finalGroups = s.messages.filter((m) => m.role === "agent-group");
    expect(finalGroups).toHaveLength(2);
    expect(finalGroups.every((m) => !isServerAuthoredRow(m))).toBe(true);
    // fan-out tool 卡始终保持 role:"tool"(未被 normalizeDelegateCards 误转组)。
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  test("mixed turn(fan-out tool 在场)+ 单数委派 progress 早于 tool_use → 复用物化组,不产生重复卡", () => {
    const s = sess();
    // 本轮已有 fan-out delegate_tasks tool 卡在场(令 hasActiveFanoutDelegate 命中)。
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "mcp__openclaude-memory__delegate_tasks",
            blockId: "tool-fanout",
            partial: false,
            inputJson: { tasks: [{ agentId: "coding-assistant", goal: "并行A" }] },
          },
        ],
      }),
    );
    // 单数委派的 progress start 先到(ordering-1)→ 兜底命中 fan-out 分支,物化成一张 agent-group。
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-solo", agentId: "hidden-reviewer", phase: "start", goal: "审查草稿", text: "开始审查" }],
      }),
    );
    expect(s.messages.filter((m) => m.role === "agent-group")).toHaveLength(1);
    // 随后单数 delegate_task tool_use 到达 → 复用同一张物化组,不新建重复卡。
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-solo",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );
    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-solo");
    expect(groups[0].blockId).toBe("tool-solo");
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(0);
  });

  test("Codex native Agent tool_use preserves OpenClaude team fallback origin fields", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Agent",
            blockId: "spawn-1",
            partial: false,
            inputJson: {
              description: "inspect repo",
              openclaudeOrigin: "codex-collab",
              openclaudeTeamFallback: true,
            },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?.text).toBe("inspect repo");
    expect(group?._delegate).toBeUndefined();
    expect(group?._agentGroupOrigin).toBe("codex-collab");
    expect(group?._teamFallback).toBe(true);
  });

  test("Agent tool_result keeps JSON result preview on completed group", () => {
    const s = sess();
    const exactOutput = `${"x".repeat(12_000)}EXACT_AGENT_RESULT_END`;
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "Agent",
            blockId: "spawn-json",
            partial: false,
            inputJson: { description: "return json" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_result",
            toolName: "Agent",
            toolUseBlockId: "spawn-json",
            blockId: "spawn-json:result",
            preview: '{"ok":true}',
            output: exactOutput,
            isError: false,
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?._completed).toBe(true);
    expect(group?._resultPreview).toBe('{"ok":true}');
    expect(group?.inputJson).toEqual({ description: "return json" });
    expect(group?.output).toBe(exactOutput);
  });

  test("standalone tool_result keeps complete output even when display preview is absent", () => {
    const s = sess();
    const exactOutput = `${"z".repeat(12_000)}EXACT_STANDALONE_RESULT_END`;
    const exactStructuredOutput = { future_field: { marker: "EXACT_STRUCTURED_RESULT" } };
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_result",
            toolName: "Bash",
            blockId: "standalone-result",
            output: exactOutput,
            outputJson: exactStructuredOutput,
            isError: false,
          },
        ],
      }),
    );

    const tool = s.messages.find((m) => m.role === "tool");
    expect(tool?.output).toBe(exactOutput);
    expect(tool?.outputJson).toEqual(exactStructuredOutput);
  });

  test("adopted delegate_progress preserves completed summary on the group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-2",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-2", agentId: "hidden-reviewer", phase: "done", text: "PASS" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-2",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?._delegateRunId).toBe("dlg-2");
    expect(group?._resultPreview).toBe("PASS");
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("delegate_task tool_use before progress nests child output into same group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-3",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-3",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-3",
            agentId: "hidden-reviewer",
            phase: "text",
            text: "child output",
            block: { kind: "text", text: "child output" },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-3");
    expect(groups[0].childBlocks?.some((b) => b.kind === "text" && b.text === "child output")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("delegate child tool keeps complete output instead of its shortened preview", () => {
    const s = sess();
    const exactOutput = `${"y".repeat(12_000)}EXACT_CHILD_TOOL_END`;
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [{
          kind: "tool_use",
          toolName: "delegate_task",
          blockId: "tool-child-exact",
          partial: false,
          inputJson: { agentId: "hidden-reviewer", goal: "检查完整输出" },
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{
          kind: "delegate_progress",
          runId: "dlg-child-exact",
          agentId: "hidden-reviewer",
          goal: "检查完整输出",
          phase: "start",
          text: "开始",
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [{
          kind: "delegate_progress",
          runId: "dlg-child-exact",
          agentId: "hidden-reviewer",
          phase: "tool",
          block: {
            kind: "tool_use",
            toolName: "Read",
            blockId: "child-read",
            inputJson: { file_path: "/tmp/exact" },
            partial: false,
          },
        }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [{
          kind: "delegate_progress",
          runId: "dlg-child-exact",
          agentId: "hidden-reviewer",
          phase: "tool",
          block: {
            kind: "tool_result",
            toolName: "Read",
            toolUseBlockId: "child-read",
            preview: "short preview",
            output: exactOutput,
            isError: false,
          },
        }],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    const child = group?.childBlocks?.find((block) => block.kind === "tool_use" && block.blockId === "child-read");
    expect(child?.output).toBe(exactOutput);
  });


  test("Codex mcpToolCall delegate_task tool_use is rendered as one realtime agent-group", () => {
    const s = sess();
    const started = {
      type: "mcpToolCall",
      id: "call_codex_delegate",
      server: "openclaude_memory",
      tool: "delegate_task",
      status: "inProgress",
      arguments: { agentId: "coding-assistant", goal: "设计水箱模拟" },
    };
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "codex:mcpToolCall",
            blockId: "call_codex_delegate",
            partial: false,
            inputJson: started,
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(0);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-codex",
            agentId: "coding-assistant",
            phase: "start",
            text: "开始委派给 coding-assistant: 设计水箱模拟",
            goal: "设计水箱模拟",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-codex",
            agentId: "coding-assistant",
            phase: "tool",
            toolName: "Bash",
            block: { kind: "tool_use", blockId: "child-bash", toolName: "Bash", inputJson: { command: "pwd" } },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe("设计水箱模拟");
    expect(groups[0]._delegateAgentId).toBe("coding-assistant");
    expect(groups[0]._delegateRunId).toBe("dlg-codex");
    expect(groups[0].childBlocks?.some((b) => b.kind === "tool_use" && b.toolName === "Bash")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("partial Codex delegate mcpToolCall converts the early tool row into one agent-group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "tool_use",
            toolName: "codex:mcpToolCall",
            blockId: "call_partial_delegate",
            partial: true,
            inputPreview: '{"type":"mcpToolCall",',
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "tool")).toHaveLength(1);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_use",
            toolName: "codex:mcpToolCall",
            blockId: "call_partial_delegate",
            partial: false,
            inputJson: {
              type: "mcpToolCall",
              id: "call_partial_delegate",
              server: "openclaude_memory",
              tool: "delegate_task",
              arguments: { agentId: "coding-assistant", goal: "设计水箱模拟" },
            },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(s.messages[0].id);
    expect(groups[0].text).toBe("设计水箱模拟");
    expect(s.messages.some((m) => m.role === "tool")).toBe(false);
  });

  test("Codex delegate progress before mcpToolCall is adopted into the same agent-group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-before-codex",
            agentId: "coding-assistant",
            phase: "start",
            text: "开始委派给 coding-assistant: 设计水箱模拟",
            goal: "设计水箱模拟",
          },
        ],
      }),
    );
    expect(s.messages.filter((m) => m.role === "delegate-progress")).toHaveLength(1);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "tool_use",
            toolName: "codex:mcpToolCall",
            blockId: "call_codex_delegate_2",
            partial: false,
            inputJson: {
              type: "mcpToolCall",
              id: "call_codex_delegate_2",
              server: "openclaude_memory",
              tool: "delegate_task",
              arguments: { agentId: "coding-assistant", goal: "设计水箱模拟" },
            },
          },
        ],
      }),
    );

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]._delegateRunId).toBe("dlg-before-codex");
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("legacy non-start delegate_progress entries are adopted without dropping output", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-4",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-4", agentId: "hidden-reviewer", phase: "text", text: "legacy output" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-4",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [{ kind: "delegate_progress", runId: "dlg-4", agentId: "hidden-reviewer", phase: "text", text: " continued" }],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?._delegateRunId).toBe("dlg-4");
    expect(group?.childBlocks?.some((b) => b.kind === "text" && b.text === "legacy output continued")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("mixed legacy entries and rich child blocks are adopted into one group", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-5",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "dlg-5", agentId: "hidden-reviewer", phase: "text", text: "legacy output" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-5",
            agentId: "hidden-reviewer",
            phase: "text",
            text: "rich output",
            block: { kind: "text", text: "rich output" },
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-5",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );

    const group = s.messages.find((m) => m.role === "agent-group");
    expect(group?._delegateRunId).toBe("dlg-5");
    expect(group?.childBlocks?.some((b) => b.kind === "text" && b.text === "legacy output")).toBe(true);
    expect(group?.childBlocks?.some((b) => b.kind === "text" && b.text === "rich output")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("adopted delegate_progress rebinds nested Agent child routing", () => {
    const s = sess();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-nested",
            agentId: "hidden-reviewer",
            phase: "start",
            text: "开始委派给 hidden-reviewer: 审查草稿",
            goal: "审查草稿",
          },
        ],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [
          {
            kind: "delegate_progress",
            runId: "dlg-nested",
            agentId: "hidden-reviewer",
            phase: "tool",
            block: { kind: "tool_use", blockId: "nested-agent-live", toolName: "Agent", inputJson: { description: "nested" } },
          },
        ],
      }),
    );
    const standalone = s.messages.find((m) => m.role === "delegate-progress");
    expect(s._agentGroups?.get("nested-agent-live")).toBe(standalone?.id);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 3,
        blocks: [
          {
            kind: "tool_use",
            toolName: "delegate_task",
            blockId: "tool-nested",
            partial: false,
            inputJson: { agentId: "hidden-reviewer", goal: "审查草稿" },
          },
        ],
      }),
    );
    const group = s.messages.find((m) => m.role === "agent-group");
    expect(s._agentGroups?.get("nested-agent-live")).toBe(group?.id);

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 4,
        blocks: [{ kind: "text", parentToolUseId: "nested-agent-live", text: "nested output" }],
      }),
    );

    expect(group?.childBlocks?.some((b) => b.kind === "text" && b.text === "nested output")).toBe(true);
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });

  test("persisted Codex delegate tool plus progress rows collapse into one agent-group", () => {
    const s = sess();
    const exactOutput = JSON.stringify({
      type: "mcpToolCall",
      id: "call_hist",
      server: "openclaude_memory",
      tool: "delegate_task",
      status: "completed",
      result: { content: [{ type: "text", text: `✅ 委派完成\n\n${"z".repeat(12_000)}EXACT_PERSISTED_DELEGATE_END` }] },
    });
    addMessage(s, "tool", "codex:mcpToolCall", {
      id: "tool-hist",
      ts: 1,
      toolName: "codex:mcpToolCall",
      blockId: "call_hist",
      inputJson: {
        type: "mcpToolCall",
        id: "call_hist",
        server: "openclaude_memory",
        tool: "delegate_task",
        arguments: { agentId: "coding-assistant", goal: "设计水箱模拟" },
      },
      _completed: true,
      output: exactOutput,
    });
    addMessage(s, "delegate-progress", "", {
      id: "progress-hist",
      ts: 2,
      runId: "dlg-hist",
      agentId: "coding-assistant",
      _delegateGoal: "设计水箱模拟",
      entries: [{ phase: "text", text: "实时输出", ts: 3 }],
      childBlocks: [{ kind: "tool_use", blockId: "nested-agent", toolName: "Agent", inputJson: { description: "nested" }, _completed: false }],
      _completed: true,
      summary: "最终方案",
    });

    normalizeDelegateCards(s);

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("tool-hist");
    expect(groups[0]._delegateRunId).toBe("dlg-hist");
    expect(groups[0]._resultPreview).toContain("委派完成");
    expect(groups[0].output).toBe(exactOutput);
    expect(groups[0].childBlocks?.some((b) => b.kind === "text" && b.text === "实时输出")).toBe(true);
    expect(s._agentGroups?.get("nested-agent")).toBe("tool-hist");
    expect(s.messages.some((m) => m.role === "tool" || m.role === "delegate-progress")).toBe(false);
  });
});

describe("process-card turn ownership", () => {
  test("request uses exact clientMessageId and settlement retains the owner", () => {
    const s = sess();
    const user = addMessage(s, "user", "需要确认", { id: "u-permission", status: "sent" });
    s._activeClientMessageId = "different-active-turn";
    const request: OutboundPermissionRequestWire = {
      type: "outbound.permission_request",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      requestId: "req-owner",
      toolName: "AskUserQuestion",
      clientMessageId: user.id,
      frameSeq: 1,
    };

    const card = applyPermissionRequest(s, request)!;
    expect(card._turnOwnerId).toBe(user.id);

    const settled: OutboundPermissionSettledWire = {
      type: "outbound.permission_settled",
      sessionKey: request.sessionKey,
      channel: request.channel,
      peer: request.peer,
      requestId: request.requestId,
      behavior: "deny",
      reason: "disconnect",
      frameSeq: 2,
    };
    applyPermissionSettled(s, settled);
    expect(card._resolved).toBe(true);
    expect(card._turnOwnerId).toBe(user.id);
  });

  test("persisted delegate tool conversion retains its exact turn owner", () => {
    const s = sess();
    const user = addMessage(s, "user", "委派任务", { id: "u-delegate", status: "sent" });
    s._activeClientMessageId = user.id;
    const tool = addMessage(s, "tool", "delegate_task", {
      id: "tool-delegate",
      toolName: "delegate_task",
      blockId: "block-delegate",
      inputJson: { agentId: "coder", goal: "检查实现" },
      _completed: true,
    });
    expect(tool._clientMessageId).toBe(user.id);

    normalizeDelegateCards(s);

    expect(tool.role).toBe("agent-group");
    expect(tool._turnOwnerId).toBe(user.id);
  });
});

describe("normalizeDelegateCards — server-authored 团队行折叠(债A)", () => {
  test("本地富卡与 server 骨架同 runId → 丢弃 server 骨架(local-wins,保住 childBlocks)", () => {
    const s = sess();
    addMessage(s, "agent-group", "研究", {
      id: "m-g",
      ts: 1,
      _delegate: true,
      _delegateAgentId: "coder",
      _delegateGoal: "研究",
      _delegateRunId: "run-1",
      _completed: true,
      childBlocks: [{ kind: "text", text: "过程输出" }],
    });
    addMessage(s, "agent-group", "研究", {
      id: "srv-g",
      ts: 2,
      _source: "server",
      _delegate: true,
      _delegateRunId: "run-1",
      _completed: true,
      _delegateStatus: "ok",
      _resultPreview: "server 摘要",
    });

    normalizeDelegateCards(s);

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups.map((g) => g.id)).toEqual(["m-g"]);
    expect(groups[0].childBlocks?.length).toBe(1);
  });

  test("多个 server 骨架共享同一 runId → 只留首个(去重)", () => {
    const s = sess();
    addMessage(s, "agent-group", "A", { id: "srv-a", ts: 1, _source: "server", _delegateRunId: "run-9", _completed: true, _delegateStatus: "ok" });
    addMessage(s, "agent-group", "A", { id: "srv-b", ts: 2, _source: "server", _delegateRunId: "run-9", _completed: true, _delegateStatus: "ok" });

    normalizeDelegateCards(s);

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups.map((g) => g.id)).toEqual(["srv-a"]);
  });

  test("跨设备仅 server 骨架(无本地富卡)→ 保留渲染", () => {
    const s = sess();
    addMessage(s, "agent-group", "研究", {
      id: "srv-g",
      ts: 1,
      _source: "server",
      _delegate: true,
      _delegateRunId: "run-x",
      _completed: true,
      _delegateStatus: "ok",
      _resultPreview: "摘要",
    });

    normalizeDelegateCards(s);

    const groups = s.messages.filter((m) => m.role === "agent-group");
    expect(groups.map((g) => g.id)).toEqual(["srv-g"]);
  });

  test("live delegate_progress 绑回本地富卡,不落到同 runId 的 server 骨架(债A 守卫)", () => {
    const s = sess();
    // 本地富卡:delegate tool_use 产出,尚无 _delegateRunId。
    addMessage(s, "agent-group", "审查草稿", {
      id: "m-g",
      ts: 1,
      _delegate: true,
      _delegateAgentId: "hidden-reviewer",
      _delegateGoal: "审查草稿",
      childBlocks: [],
    });
    // server 骨架:同 runId,已带 _delegateRunId(跨设备终态)。
    addMessage(s, "agent-group", "审查草稿", {
      id: "srv-g",
      ts: 2,
      _source: "server",
      _delegate: true,
      _delegateAgentId: "hidden-reviewer",
      _delegateGoal: "审查草稿",
      _delegateRunId: "run-1",
      _completed: true,
      _delegateStatus: "ok",
    });

    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        blocks: [{ kind: "delegate_progress", runId: "run-1", agentId: "hidden-reviewer", goal: "审查草稿", phase: "start" }],
      }),
    );
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 2,
        blocks: [{ kind: "delegate_progress", runId: "run-1", agentId: "hidden-reviewer", phase: "text", text: "审查进行中" }],
      }),
    );

    const local = s.messages.find((m) => m.id === "m-g")!;
    const server = s.messages.find((m) => m.id === "srv-g")!;
    expect(local._delegateRunId).toBe("run-1"); // 绑到本地富卡
    expect(local.childBlocks?.some((b) => b.kind === "text" && b.text === "审查进行中")).toBe(true);
    expect(server.childBlocks ?? []).toHaveLength(0); // server 骨架不接收 live childBlocks
    // 不新建独立 delegate-progress 兜底卡
    expect(s.messages.some((m) => m.role === "delegate-progress")).toBe(false);
  });
});

describe("applyOutboundError double-frame suppression (§11)", () => {
  test("[error] text isFinal at suppressed seq does not add a second bubble", () => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    const persistSession = vi.fn();
    applyOutboundError(
      s,
      { type: "outbound.error", sessionKey: "k", channel: "webchat", peer: { id: "s1", kind: "dm" }, code: "insufficient_credits", message: "no credits", isFinal: false, frameSeq: 5 } as never,
      { persistSession },
    );
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s._suppressErrorBubbleAtSeq).toBe(6);
    expect(s._sendingInFlight).toBe(false);
    expect(s.messages.find((m) => m.role === "user")?.status).toBe("error");
    expect(persistSession).toHaveBeenCalledWith("s1");
    // following [error] text isFinal at seq 6 → suppressed bubble, still teardown.
    applyOutboundMessage(s, msgFrame({ frameSeq: 6, isFinal: true, ts: 999999999999, blocks: [{ kind: "text", text: "[error] no credits" }] }));
    expect(s.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(s._sendingInFlight).toBe(false);
  });

  test("未知错误码不把内部 message 暴露到查看详情", () => {
    const s = sess();
    applyOutboundError(s, { type: "outbound.error", sessionKey: "k", channel: "webchat", peer: { id: "s1", kind: "dm" }, code: "some_new_code", message: "server shutting down", isFinal: true } as never);
    const err = s.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(err.text).toBe("系统暂时不可用，请稍后重试。"); // 友好通用,不抛裸英文
    expect(err._errorDetail).toBe("系统暂时不可用，请稍后重试。");
    expect(err._errorDetail).not.toMatch(/server shutting down/);
  });

  test("legacy Stop terminal renders as cancelled without telemetry or automatic recovery", () => {
    const s = sess();
    const user = addMessage(s, "user", "long task", { status: "sent", ts: 1 });
    const reportTurnError = vi.fn();
    const scheduleAutomaticRecovery = vi.fn();
    applyOutboundError(s, {
      type: "outbound.error",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: user.id,
      code: "upstream_failed",
      message: "任务执行暂时中断，请直接重试本条消息",
      detail: "本轮已由用户停止。",
      isFinal: false,
    } as never, { reportTurnError, scheduleAutomaticRecovery });

    expect(s.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "本轮已取消。",
      _errorCode: "user_cancelled",
      _errorDetail: "本轮已取消。",
    });
    expect(reportTurnError).not.toHaveBeenCalled();
    expect(scheduleAutomaticRecovery).not.toHaveBeenCalled();
  });

  test("only automatic-recovery taxonomy codes schedule recovery", () => {
    const nonRecoverable = vi.fn();
    applyOutboundError(sess(), {
      type: "outbound.error",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      code: "insufficient_credits",
      message: "no credits",
      isFinal: true,
    } as never, { scheduleAutomaticRecovery: nonRecoverable });
    expect(nonRecoverable).not.toHaveBeenCalled();

    const recoverable = vi.fn();
    applyOutboundError(sess(), {
      type: "outbound.error",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      code: "upstream_failed",
      message: "upstream failed",
      isFinal: true,
    } as never, { scheduleAutomaticRecovery: recoverable });
    expect(recoverable).toHaveBeenCalledWith("s1", undefined);
  });

  test("scoped stale error marks only its client row and cannot tear down a newer turn", () => {
    const s = sess();
    const older = addMessage(s, "user", "older", { status: "sent", ts: 1 });
    const newer = addMessage(s, "user", "newer", { status: "sent", ts: 2 });
    s._sendingInFlight = true;
    s._activeClientMessageId = newer.id;
    applyOutboundError(s, {
      type: "outbound.error",
      sessionKey: "k",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: older.id,
      code: "upstream_failed",
      message: "任务执行暂时中断，请直接重试本条消息",
      detail: "raw provider detail",
      isFinal: false,
    } as never);
    expect(older.status).toBe("error");
    expect(newer.status).toBe("sent");
    expect(s._sendingInFlight).toBe(true);
    expect(s._activeClientMessageId).toBe(newer.id);
    expect(s.messages.at(-1)).toMatchObject({
      role: "assistant",
      _clientMessageId: older.id,
      _errorDetail: "任务执行暂时中断，你的消息已保留，可直接重试。",
    });
  });

  test("legacy bridge error 无 final：本地收尾后立即 persist false", () => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    const persistSession = vi.fn();
    applyLegacyBridgeError(
      s,
      { type: "error", code: "ERR_INTERNAL", message: "boom", traceId: "t1" } as never,
      { persistSession },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(s.messages.find((m) => m.role === "user")?.status).toBe("error");
    expect(persistSession).toHaveBeenCalledWith("s1");
  });
});

// 遥测上报口径:改用 REPORT_EXEMPT(reportable===false),与 expected 解耦(Codex 审计 R5c)。
describe("applyOutboundError 遥测上报口径(R5c:report-exempt 而非 expected)", () => {
  const fire = (code: string) => {
    const s = sess();
    addMessage(s, "user", "hi", { status: "sent", ts: 1 });
    s._sendingInFlight = true;
    const reportTurnError = vi.fn();
    applyOutboundError(
      s,
      { type: "outbound.error", channel: "webchat", peer: { id: "s1", kind: "dm" }, code, message: "x", isFinal: true } as never,
      { reportTurnError },
    );
    return reportTurnError;
  };

  test("rate_limited / model_capacity / service_restart / image_server_busy → 恢复上报(平台运营信号)", () => {
    for (const code of ["rate_limited", "model_capacity", "service_restart", "image_server_busy"]) {
      expect(fire(code)).toHaveBeenCalledWith(expect.objectContaining({ code }));
    }
  });

  test("stopped / user_cancelled / insufficient_credits / maintenance → 仍豁免上报(用户主动/业务拒绝)", () => {
    for (const code of ["stopped", "user_cancelled", "insufficient_credits", "maintenance"]) {
      expect(fire(code)).not.toHaveBeenCalled();
    }
  });

  test("基建故障(engine_error / model_authority_unavailable)→ 上报", () => {
    expect(fire("engine_error")).toHaveBeenCalled();
    expect(fire("model_authority_unavailable")).toHaveBeenCalled();
  });
});

// 精确重试资格(红卡 CTA 硬门 R4):与 retryMessage 实际读取字段严格对齐。
describe("preciseRetryEligible(Codex 审计 R4:精确重试完整性硬门)", () => {
  const base = (over: Partial<ChatMessage>): ChatMessage =>
    ({ id: "u1", role: "user", text: "hi", ts: 1, status: "error", ...over }) as ChatMessage;

  test("自带 _routing、无附件 → 可精确重试", () => {
    expect(preciseRetryEligible(base({ _routing: { model: "m", teamMode: false, effortLevel: null } }))).toBe(true);
  });

  test("无 _routing(依赖 _lastRouting 回退)→ 不可精确重试(不借用别轮快照)", () => {
    expect(preciseRetryEligible(base({ _routing: undefined }))).toBe(false);
  });

  test("带附件且 media 仍携带 url/base64 → 可精确重试", () => {
    expect(
      preciseRetryEligible(
        base({ _routing: { teamMode: false }, _media: [{ kind: "image", url: "https://x/a.png" }] }),
      ),
    ).toBe(true);
  });

  test("带附件但 media 只剩 localSrc(url/base64 均缺)→ 不可精确重试(重发证据已丢)", () => {
    expect(
      preciseRetryEligible(
        base({ _routing: { teamMode: false }, _media: [{ kind: "image", localSrc: "blob:abc" }] }),
      ),
    ).toBe(false);
  });

  test("_retryMedia 优先于 _media 作重发源(imageEdit 剥离 localSrc 的出站版本)", () => {
    // _media 只剩 localSrc,但 _retryMedia 带 url → 按 retryMessage 实读源(_retryMedia ?? _media)判为可重发。
    expect(
      preciseRetryEligible(
        base({
          _routing: { teamMode: false },
          _media: [{ kind: "image", localSrc: "blob:abc" }],
          _retryMedia: [{ kind: "image", url: "https://x/a.png" }],
        }),
      ),
    ).toBe(true);
  });

  test("超大 user locator 只依据落库时的精确 sidecar 能力元数据，不把附件塞回热行", () => {
    expect(preciseRetryEligible(base({
      _routing: { model: "m", teamMode: false, effortLevel: null },
      _userPayloadDeferred: true,
      _deferredRetryEligible: true,
    }))).toBe(true);
    expect(preciseRetryEligible(base({
      _routing: { model: "m", teamMode: false, effortLevel: null },
      _userPayloadDeferred: true,
      _deferredRetryEligible: false,
    }))).toBe(false);
  });
});

describe("interruptedContinuationTarget (durable 断点续跑)", () => {
  const routing = { model: "kimi-k3-ark", teamMode: false, effortLevel: "high" as const };
  const rows = (): ChatMessage[] => [
    {
      id: "u-interrupted",
      role: "user",
      text: "发布这张图",
      ts: 1,
      status: "read",
      _source: "server",
      _routing: routing,
      _media: [{ kind: "image", url: "https://example.test/original.png" }],
    },
    {
      id: "thinking-1",
      role: "thinking",
      text: "已经完成图片处理",
      ts: 2,
      _source: "server",
      _turnTapeId: "tape-1",
      _clientMessageId: "u-interrupted",
    },
    {
      id: "error-1",
      role: "assistant",
      text: "",
      ts: 3,
      _source: "server",
      _turnTapeId: "tape-1",
      _clientMessageId: "u-interrupted",
      _errorCode: "LIVENESS_TIMEOUT",
      usage: { waived: true },
    },
  ];

  test("刷新后 user status 非 error，仍凭原 routing + durable process 给出断点目标", () => {
    const messages = rows();
    const target = interruptedContinuationTarget(messages, messages[2], "s1");
    expect(target?.user.id).toBe("u-interrupted");
    expect(target?.clientMessageId).toMatch(/^m-recover-[A-Za-z0-9_-]+$/);
  });

  test("只有 user + terminal，或过程尚非 durable 时，不承诺断点续跑", () => {
    const messages = rows();
    messages.splice(1, 1);
    expect(interruptedContinuationTarget(messages, messages[1], "s1")).toBeUndefined();
    messages.splice(1, 0, {
      id: "local-thinking",
      role: "thinking",
      text: "仅本地乐观过程",
      ts: 2,
      _clientMessageId: "u-interrupted",
    });
    expect(interruptedContinuationTarget(messages, messages[2], "s1")).toBeUndefined();
  });

  test("已有后继 user/continuation 时旧错误不再可续，且 identity 跨实例稳定", () => {
    const first = interruptedContinuationIdentity("s1", "u-interrupted");
    const second = interruptedContinuationIdentity("s1", "u-interrupted");
    const other = interruptedContinuationIdentity("s1", "u-other");
    expect(first).toEqual(second);
    expect(first.clientMessageId).not.toBe(other.clientMessageId);
    const messages = rows();
    messages.push({
      id: first.clientMessageId,
      role: "user",
      text: "↻ 从断点继续",
      ts: 4,
      _idem: first.idempotencyKey,
      _continuationOfClientMessageId: "u-interrupted",
    });
    expect(interruptedContinuationTarget(messages, messages[2], "s1")).toBeUndefined();
  });

  test("自动恢复按 durable 过程选择 checkpoint；无过程才精确 replay", () => {
    const checkpointRows = rows();
    checkpointRows[2]._errorCode = "model_capacity";
    expect(
      automaticTurnRecoveryTarget(checkpointRows, checkpointRows[2], "s1")?.mode,
    ).toBe("checkpoint");

    const replayRows = rows();
    replayRows.splice(1, 1);
    replayRows[1]._errorCode = "upstream_failed";
    expect(
      automaticTurnRecoveryTarget(replayRows, replayRows[1], "s1")?.mode,
    ).toBe("replay");
  });

  test("未完成工具、结果未知和未解决审批只保留人工入口，不自动续跑", () => {
    const unsafeVariants: ChatMessage[][] = [
      [
        {
          id: "tool-pending",
          role: "tool",
          text: "Plugin write",
          ts: 2,
          _source: "server",
          _turnTapeId: "tape-1",
          _completed: false,
        },
      ],
      [
        {
          id: "tool-unknown",
          role: "tool",
          text: "Plugin write",
          ts: 2,
          _source: "server",
          _turnTapeId: "tape-1",
          _completed: true,
          outputJson: { status: "unknown" },
        },
      ],
      [
        {
          id: "permission-pending",
          role: "permission",
          text: "Write",
          ts: 2,
          _source: "server",
          _turnTapeId: "tape-1",
          _resolved: false,
        },
        {
          id: "thinking-after-permission",
          role: "thinking",
          text: "waiting",
          ts: 2.5,
          _source: "server",
          _turnTapeId: "tape-1",
        },
      ],
    ];
    for (const variant of unsafeVariants) {
      const messages = rows();
      messages.splice(1, 1, ...variant);
      expect(
        automaticTurnRecoveryTarget(messages, messages.at(-1)!, "s1"),
      ).toBeUndefined();
      expect(
        interruptedContinuationTarget(messages, messages.at(-1)!, "s1"),
      ).toBeDefined();
    }
  });

  test("自动恢复沿同一根单调推进至 10 次，认证/配额等不可自动码不进入", () => {
    const alreadyAutomatic = rows();
    alreadyAutomatic[0]._automaticRecovery = true;
    alreadyAutomatic[0]._automaticRecoveryRootClientMessageId = "u-interrupted";
    alreadyAutomatic[0]._automaticRecoveryAttempt = 1;
    expect(automaticTurnRecoveryTarget(
      alreadyAutomatic,
      alreadyAutomatic[2],
      "s1",
    )).toMatchObject({ rootClientMessageId: "u-interrupted", attempt: 2, max: 10 });
    alreadyAutomatic[2]._automaticRetryRootClientMessageId = "u-interrupted";
    alreadyAutomatic[2]._automaticRetryAttempt = 10;
    alreadyAutomatic[2]._automaticRetryMax = 10;
    expect(automaticTurnRecoveryTarget(
      alreadyAutomatic,
      alreadyAutomatic[2],
      "s1",
    )).toBeUndefined();

    const auth = rows();
    auth[2]._errorCode = "auth_error";
    expect(automaticTurnRecoveryTarget(auth, auth[2], "s1")).toBeUndefined();
    expect(interruptedContinuationTarget(auth, auth[2], "s1")).toBeUndefined();
  });
});

describe("applyCostWaived (turn 免单退款)", () => {
  test("迟到的 A 轮免单只修改精确 turnKey，不碰更新的 B 轮或无归属 pending", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "A", {
      ts: 1,
      _turnKey: "a".repeat(64),
      usage: { costCredits: "11" },
    });
    const b = addMessage(s, "assistant", "B", {
      ts: 2,
      _turnKey: "b".repeat(64),
      usage: { costCredits: "7" },
    });
    s._pendingCostCredits = "6";
    const refreshBalance = vi.fn();
    applyCostWaived(s, {
      type: "outbound.cost_waived",
      sessionId: "x",
      turnKey: "a".repeat(64),
      refundedCredits: "11",
      balanceAfter: "100",
    }, { refreshBalance });
    expect(a.usage?.costCredits).toBe("11");
    expect(a.usage?.waived).toBe(true);
    expect(b.usage).toEqual({ costCredits: "7" });
    expect(s._pendingCostCredits).toBe("6");
    expect(refreshBalance).toHaveBeenCalledTimes(1);
  });
  test("零额退款仍给精确轮标 waived（无扣费轮也有站内信回执）", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "无响应", { ts: 1, _turnKey: "c".repeat(64) });
    applyCostWaived(s, {
      type: "outbound.cost_waived",
      turnKey: "c".repeat(64),
      refundedCredits: "0",
    }, {});
    expect(a.usage?.waived).toBe(true);
  });
  test("无 session / turnKey 未命中 → 只刷余额，不猜最近一轮", () => {
    const refreshBalance = vi.fn();
    applyCostWaived(null, {
      type: "outbound.cost_waived",
      turnKey: "d".repeat(64),
      refundedCredits: "11",
      balanceAfter: "1",
    }, { refreshBalance });
    expect(refreshBalance).toHaveBeenCalledTimes(1);
    const s = sess();
    const forceSync = vi.fn();
    const latest = addMessage(s, "assistant", "B", {
      ts: 2,
      _turnKey: "e".repeat(64),
      usage: { costCredits: "9" },
    });
    s._pendingCostCredits = "4";
    applyCostWaived(s, {
      type: "outbound.cost_waived",
      turnKey: "f".repeat(64),
      refundedCredits: "9",
    }, { forceSync });
    expect(latest.usage).toEqual({ costCredits: "9" });
    expect(s._pendingCostCredits).toBe("4");
    expect(forceSync).toHaveBeenCalledWith(s.id);
  });
  test("滚动升级期间缺 turnKey 的旧帧不会命中同样未标记的历史消息", () => {
    const s = sess();
    const legacy = addMessage(s, "assistant", "旧消息", { ts: 1, usage: { costCredits: "8" } });
    applyCostWaived(s, {
      type: "outbound.cost_waived",
      turnKey: undefined as never,
      refundedCredits: "8",
    }, {});
    expect(legacy.usage).toEqual({ costCredits: "8" });
  });
});

describe("applyCostCharged (§3 NOT deduped; 归因严格)", () => {
  test("active multi-request turn reminder uses actual debit and dedupes requestId", () => {
    const s = sess();
    s._sendingInFlight = true;
    const a = addMessage(s, "assistant", "ans", { ts: 1, usage: {} });
    s._streamingAssistant = a;

    applyCostCharged(s, {
      type: "outbound.cost_charged",
      requestId: "req-1",
      costCredits: "600",
      debitedCredits: "300",
    }, {});
    applyCostCharged(s, {
      type: "outbound.cost_charged",
      requestId: "req-1",
      costCredits: "600",
      debitedCredits: "300",
    }, {});
    expect(s._turnCostCredits).toBe("300");
    expect(s._turnCostReminderCredits).toBeUndefined();
    // Existing response badge deliberately keeps its no-frameSeq behavior.
    expect(a.usage?.costCredits).toBe("1200");

    applyCostCharged(s, {
      type: "outbound.cost_charged",
      requestId: "req-2",
      costCredits: "250",
      debitedCredits: "250",
    }, {});
    expect(s._turnCostCredits).toBe("550");
    expect(s._turnCostReminderCredits).toBe("550");
  });

  test("media/legacy frame without requestId and inactive turn never drive reminder", () => {
    const s = sess();
    s._sendingInFlight = true;
    applyCostCharged(s, {
      type: "outbound.cost_charged",
      costCredits: "900",
    }, {});
    expect(s._turnCostCredits).toBe("0");
    expect(s._turnCostReminderCredits).toBeUndefined();

    s._sendingInFlight = false;
    applyCostCharged(s, {
      type: "outbound.cost_charged",
      requestId: "late-1",
      costCredits: "900",
    }, {});
    expect(s._turnCostCredits).toBe("0");
    expect(s._turnCostReminderCredits).toBeUndefined();
  });

  test("turn cleanup clears reminder counter and request-id fence", () => {
    const s = sess();
    s._sendingInFlight = true;
    applyCostCharged(s, {
      type: "outbound.cost_charged",
      requestId: "req-clean",
      costCredits: "500",
    }, {});
    expect(s._turnCostReminderCredits).toBe("500");

    clearTurnTiming(s);
    expect(s._turnCostCredits).toBe("0");
    expect(s._turnCostReminderCredits).toBeUndefined();
    expect(s._turnCostSeenRequestIds?.size).toBe(0);
  });

  test("target with usage → accumulate (multi-API turn)", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "ans", { ts: 1, usage: {} });
    s._streamingAssistant = a;
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "10", balanceAfter: "90" }, {});
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "10", balanceAfter: "80" }, {});
    expect(a.usage?.costCredits).toBe("20");
  });
  test("target without usage (mid-turn) → enqueue _pendingCostCredits, NOT written to row", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "", { ts: 1 }); // no usage yet
    s._streamingAssistant = a;
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "15" }, {});
    expect(a.usage).toBeUndefined();
    expect(s._pendingCostCredits).toBe("15");
  });
  test("NO target 且 turn 未进行（turn 间晚到）→ DROP, only refreshBalance (no cross-turn pollution)", () => {
    const s = sess();
    const refreshBalance = vi.fn();
    // _sendingInFlight 默认 false → 不入队（避免错算到下一 turn）。
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "99", balanceAfter: "1" }, { refreshBalance });
    expect(s._pendingCostCredits).toBe("0"); // turn 间不 enqueue
    expect(refreshBalance).toHaveBeenCalledTimes(1);
  });
  test("NO target 但 turn 进行中（委派 cost 在子状态间到达）→ enqueue pending，不丢", () => {
    const s = sess();
    s._sendingInFlight = true; // 队长等子智能体：无 streamingAssistant，但本 turn 在飞
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "7" }, {});
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "3" }, {});
    expect(s._pendingCostCredits).toBe("10"); // 累加，待收尾 flush 到本轮响应
  });
  test("isFinal: 兜底 flush pending cost 到本轮最后一条助手消息（无 streamingAssistant 时）", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "汇总", { ts: 1, usage: { traceId: "t1" } });
    s._sendingInFlight = true;
    s._pendingCostCredits = "20"; // turn 内入队、未被 meta-drain（收尾帧无 meta / 无流式助手）
    applyOutboundMessage(s, msgFrame({ isFinal: true }));
    expect(a.usage?.costCredits).toBe("20"); // flush 到响应 → 徽章可见
    expect(s._pendingCostCredits).toBe("0"); // 清零防泄漏到下一 turn
  });
  test("isFinal 兜底 flush 不跨轮：本轮无 assistant 时 pending 不落到上一轮 assistant", () => {
    const s = sess();
    const prev = addMessage(s, "assistant", "上一轮", { ts: 1, usage: { costCredits: "5" } });
    addMessage(s, "user", "本轮提问", { ts: 2 }); // 本轮起点；本轮只有 tool/thinking、无 assistant 汇总
    s._sendingInFlight = true;
    s._pendingCostCredits = "20";
    applyOutboundMessage(s, msgFrame({ isFinal: true }));
    expect(prev.usage?.costCredits).toBe("5"); // 上一轮 assistant 不被错算（不跨 turn）
    expect(s._pendingCostCredits).toBe("0"); // 本轮无响应可落 → 丢展示、清零防泄漏
  });

  // ── Fix B — 委派成本(parentSessionId)在飞时跳过陈旧 lastFinaled ──
  test("委派 cost + 队长 turn 在飞 + 60s 内 lastFinaled(上一轮)→ 入队本轮 pending,不错算上一轮", () => {
    const s = sess();
    const prevTurn = addMessage(s, "assistant", "上一轮响应", { ts: 1, usage: { costCredits: "5" } });
    s._lastFinaledAssistantId = prevTurn.id; // 上一轮刚 final(<60s)
    s._lastFinaledAt = Date.now();
    s._sendingInFlight = true; // 队长本轮在飞、等委派,无 streamingAssistant
    // 委派子智能体成本到达(带 parentSessionId)。旧逻辑会命中 60s lastFinaled → 错算到上一轮;
    // Fix B:委派 + 在飞 → 跳过 lastFinaled,入队本轮 pending。
    applyCostCharged(s, {
      type: "outbound.cost_charged", sessionId: "engine-deleg", parentSessionId: "s1", costCredits: "8",
    }, {});
    expect(prevTurn.usage?.costCredits).toBe("5"); // 上一轮不被污染
    expect(s._pendingCostCredits).toBe("8"); // 归入本轮,待队长 isFinal flush
  });

  test("普通 chat(无 parentSessionId)行为不变:在飞 + 60s lastFinaled → 仍累加到 lastFinaled", () => {
    const s = sess();
    const last = addMessage(s, "assistant", "刚收尾", { ts: 1, usage: { costCredits: "5" } });
    s._lastFinaledAssistantId = last.id;
    s._lastFinaledAt = Date.now();
    s._sendingInFlight = true;
    // 无 parentSessionId → 走既有启发式(命中 lastFinaled)。锁定普通 chat 零行为变化。
    applyCostCharged(s, { type: "outbound.cost_charged", sessionId: "s1", costCredits: "3" }, {});
    expect(last.usage?.costCredits).toBe("8"); // 5 + 3
    expect(s._pendingCostCredits).toBe("0");
  });

  test("委派 cost + 有 streamingAssistant → 仍直接落流式助手(优先级不变)", () => {
    const s = sess();
    const a = addMessage(s, "assistant", "队长流式", { ts: 1, usage: {} });
    s._streamingAssistant = a;
    s._sendingInFlight = true;
    applyCostCharged(s, {
      type: "outbound.cost_charged", sessionId: "engine-deleg", parentSessionId: "s1", costCredits: "6",
    }, {});
    expect(a.usage?.costCredits).toBe("6"); // streamingAssistant 优先,不受 parentSessionId 影响
  });
});

describe("service_restart 合成 final：无在途流 → 不生成 phantom 中断气泡（§11）", () => {
  // Bug 形态：idle 会话（agent 未在响应）在 master 重启后凭空出现「服务重启中断」持久卡。
  // 根因：gateway 对上报 inFlight 的 warm session 补推 service_restart final；旧代码让其
  // ⚠️ text 块走进 §7 block 循环 → findOrCreateStreamingRow 新建 assistant 气泡 → 持久落库。
  // 修复：仅「本地确有在途流式内容」才当真被掐断（续写）；否则带外静默收口、绝不建气泡。
  test("无 streamingAssistant + ⚠️ text 块（旧服务端形态）→ 不新建气泡、清发送态并调度 exact 恢复核验", () => {
    const s = sess();
    addMessage(s, "user", "问题", { status: "read", ts: 1 });
    const done = addMessage(s, "assistant", "上一轮答案", { ts: 2, completedAt: 3 });
    s._sendingInFlight = true; // stale：turn 早已结束但 flag 卡住（dropped final / tool-only 卡死）
    const before = s.messages.length;
    const scheduleAutomaticRecovery = vi.fn();
    const onFinal = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [{ kind: "text", text: "\n\n⚠️ 上一轮对话被服务重启中断，请重新发送消息继续。" }],
        meta: { interrupted: "service_restart" },
      }),
      { scheduleAutomaticRecovery, onFinal },
    );
    expect(s.messages.length).toBe(before); // phantom 气泡不产生
    expect(s.messages.some((m) => (m.text ?? "").includes("上一轮对话被服务重启中断"))).toBe(false);
    expect(s._sendingInFlight).toBe(false);
    expect(scheduleAutomaticRecovery).toHaveBeenCalledWith(s.id, undefined);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(done.text).toBe("上一轮答案"); // 已完成答案不受影响
  });

  test("空 blocks（新服务端对称形态）+ 无在途流 → 静默收口并调度 exact 恢复核验", () => {
    const s = sess();
    s._sendingInFlight = true;
    const before = s.messages.length;
    const scheduleAutomaticRecovery = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 9e12, blocks: [], meta: { interrupted: "service_restart" } }),
      { scheduleAutomaticRecovery },
    );
    expect(s.messages.length).toBe(before);
    expect(s._sendingInFlight).toBe(false);
    expect(scheduleAutomaticRecovery).toHaveBeenCalledWith(s.id, undefined);
  });

  test("双发（12ms 内两帧，双 tab/双 reconnect）→ 都被拦，仍不建任何气泡", () => {
    const s = sess();
    s._sendingInFlight = true;
    const scheduleAutomaticRecovery = vi.fn();
    const restartFinal = (seq: number) =>
      msgFrame({
        frameSeq: seq,
        isFinal: true,
        ts: 9e12 + seq,
        blocks: [{ kind: "text", text: "\n\n⚠️ 上一轮对话被服务重启中断，请重新发送消息继续。" }],
        meta: { interrupted: "service_restart" },
      });
    applyOutboundMessage(s, restartFinal(1), { scheduleAutomaticRecovery });
    applyOutboundMessage(s, restartFinal(2), { scheduleAutomaticRecovery });
    expect(s.messages.some((m) => (m.text ?? "").includes("上一轮对话被服务重启中断"))).toBe(false);
    expect(scheduleAutomaticRecovery).toHaveBeenCalledTimes(2);
  });

  test("有在途流式正文（真·被上游断流掐断）→ 落通用 final：调度自动续写、清发送态、正文保留", () => {
    const s = sess();
    addMessage(s, "user", "写篇长文", { status: "read", ts: 1 });
    const streaming = addMessage(s, "assistant", "已经写了一半…", { ts: 2 });
    s._streamingAssistant = streaming;
    s._sendingInFlight = true;
    const scheduleAutomaticRecovery = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: 9e12, blocks: [], meta: { interrupted: "service_restart" } }),
      { scheduleAutomaticRecovery },
    );
    expect(scheduleAutomaticRecovery).toHaveBeenCalledWith(s.id, undefined);
    expect(s._sendingInFlight).toBe(false);
    expect(streaming.text).toContain("已经写了一半"); // 在途正文保留
  });

  test("有 queued user → 带外清扫不绑新轮、仅调度 exact 核验、不建气泡", () => {
    const s = sess();
    addMessage(s, "user", "已发", { status: "read", ts: 1 });
    const streaming = addMessage(s, "assistant", "半句", { ts: 2 });
    s._streamingAssistant = streaming;
    addMessage(s, "user", "排队中的下一条", { status: "queued", ts: 3 });
    s._sendingInFlight = true;
    const scheduleAutomaticRecovery = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [{ kind: "text", text: "\n\n⚠️ 上一轮对话被服务重启中断，请重新发送消息继续。" }],
        meta: { interrupted: "service_restart" },
      }),
      { scheduleAutomaticRecovery },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(scheduleAutomaticRecovery).toHaveBeenCalledWith(s.id, undefined);
    expect(s.messages.some((m) => m.role === "user" && m.status === "queued")).toBe(true); // 排队消息仍在
    expect(s.messages.some((m) => (m.text ?? "").includes("上一轮对话被服务重启中断"))).toBe(false);
  });
});

describe("applyResumeFailed (§4 layer 3)", () => {
  test("advances cursor to server currentLast, flags broken, forces sync", () => {
    const s = sess();
    const forceSync = vi.fn();
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 42, reason: "buffer_miss" } as never, { forceSync });
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    expect(s._liveStreamBroken).toBe(true);
    expect(forceSync).toHaveBeenCalledWith("s1");
  });
});

describe("reconcile 合成 final (meta.reconcile==='turn_completed')", () => {
  test("清发送态 + forceSync + 不新增空 assistant 气泡", () => {
    const s = sess();
    const u = addMessage(s, "user", "问题", { status: "sent" });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    const forceSync = vi.fn();
    const before = s.messages.length;
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: Date.now(), blocks: [], meta: { reconcile: "turn_completed" } }),
      { forceSync },
    );
    expect(s._sendingInFlight).toBe(false);
    expect(forceSync).toHaveBeenCalledWith("s1");
    // 空 blocks final 不合成空轮气泡(内容其实已在服务端生成,靠 forceSync 拉回)。
    expect(s.messages.length).toBe(before);
    expect(s.messages.some((m) => m.role === "assistant")).toBe(false);
    expect(s.messages.some((m) => m._emptyTurn)).toBe(false);
  });

  test("普通空 blocks final(无 reconcile 标记)仍走既有空轮路径,不误触发 forceSync", () => {
    const s = sess();
    const u = addMessage(s, "user", "问题", { status: "sent" });
    s._replyingToMsgId = u.id;
    s._sendingInFlight = true;
    const forceSync = vi.fn();
    applyOutboundMessage(
      s,
      msgFrame({ frameSeq: 1, isFinal: true, ts: Date.now(), blocks: [], meta: { stopReason: "end_turn" } }),
      { forceSync },
    );
    expect(forceSync).not.toHaveBeenCalled();
    expect(s._sendingInFlight).toBe(false);
  });
});

// ═══════════════ §2 safeWsSend 背压 + §10 离线入队（ChatSocket）═══════════════
class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  url: string;
  protocols?: string | string[];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed?: { code: number; reason: string };
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }
}

function makeSocket(overrides: Partial<ChatSocketDeps> = {}) {
  return new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ...overrides,
  });
}

describe("ChatSocket interrupted continuation", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("追加确定性 continuation，不改旧过程、不重传原 prompt/附件，重复点击只发一次", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const session = sock.ensureSession("s1", "main");
    session.messages.push(
      {
        id: "u-interrupted",
        role: "user",
        text: "原始任务",
        ts: 1,
        status: "read",
        _routing: { model: "kimi-k3-ark", teamMode: true, effortLevel: "high" },
        _media: [{ kind: "image", url: "https://example.test/original.png" }],
      },
      {
        id: "tool-1",
        role: "tool",
        text: "ImageEdit",
        ts: 2,
        _source: "server",
        _turnTapeId: "tape-1",
        _clientMessageId: "u-interrupted",
      },
      {
        id: "error-1",
        role: "assistant",
        text: "",
        ts: 3,
        _source: "server",
        _turnTapeId: "tape-1",
        _clientMessageId: "u-interrupted",
        _errorCode: "idle_timeout",
        usage: { waived: true },
      },
    );
    const before = session.messages.map((message) => structuredClone(message));

    sock.continueInterruptedTurn({ sessId: "s1", errorMessageId: "error-1", agentId: "main" });
    sock.continueInterruptedTurn({ sessId: "s1", errorMessageId: "error-1", agentId: "main" });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.messages.slice(0, before.length)).toEqual(before);
    expect(session.messages).toHaveLength(before.length + 1);
    const continuation = session.messages.at(-1)!;
    const identity = interruptedContinuationIdentity("s1", "u-interrupted");
    expect(continuation).toMatchObject({
      id: identity.clientMessageId,
      role: "user",
      text: "↻ 从断点继续",
      _idem: identity.idempotencyKey,
      _continuationOfClientMessageId: "u-interrupted",
      _routing: { model: "kimi-k3-ark", teamMode: true, effortLevel: "high" },
    });
    const payloads = ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, any>)
      .filter((payload) => payload.type === "inbound.message");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      clientMessageId: identity.clientMessageId,
      idempotencyKey: identity.idempotencyKey,
      model: "kimi-k3-ark",
      teamMode: true,
      effortLevel: "high",
      content: { text: expect.stringContaining("从断点继续") },
    });
    expect(payloads[0].content.media).toBeUndefined();
    expect(payloads[0].content.text).not.toContain("原始任务");
    sock.stop();
  });

  test("两个独立 tab 对同一中断轮生成相同 durable identity", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sockets = [makeSocket(), makeSocket()];
    for (const sock of sockets) {
      sock.setGateReady(true);
      const ws = FakeWS.instances.at(-1)!;
      ws.open();
      const session = sock.ensureSession("s1", "main");
      session.messages.push(
        {
          id: "u-interrupted",
          role: "user",
          text: "task",
          ts: 1,
          status: "read",
          _routing: { model: "kimi-k3-ark", teamMode: false },
        },
        {
          id: "thinking-1",
          role: "thinking",
          text: "progress",
          ts: 2,
          _source: "server",
          _turnTapeId: "tape-1",
          _clientMessageId: "u-interrupted",
        },
        {
          id: "error-1",
          role: "assistant",
          text: "",
          ts: 3,
          _source: "server",
          _turnTapeId: "tape-1",
          _clientMessageId: "u-interrupted",
          _errorCode: "LIVENESS_TIMEOUT",
        },
      );
      sock.continueInterruptedTurn({ sessId: "s1", errorMessageId: "error-1", agentId: "main" });
    }
    await Promise.resolve();
    await Promise.resolve();
    const wires = FakeWS.instances.map((ws) =>
      ws.sent
        .map((raw) => JSON.parse(raw) as Record<string, any>)
        .find((payload) => payload.type === "inbound.message"),
    );
    expect(wires[0]?.clientMessageId).toBe(wires[1]?.clientMessageId);
    expect(wires[0]?.idempotencyKey).toBe(wires[1]?.idempotencyKey);
    sockets.forEach((sock) => sock.stop());
  });

  test("durable live-frame pages rebuild the exact interrupted process without deleting user or tape rows", () => {
    const persisted: string[] = [];
    const sock = makeSocket({ persistSession: (id) => persisted.push(id) });
    const session = sock.ensureSession("s-live-restore", "main");
    session.messages.push(
      {
        id: "cm-live-restore",
        role: "user",
        text: "long task",
        ts: 1,
        status: "sent",
        _source: "server",
      },
      {
        id: "stale-client-thinking",
        role: "thinking",
        text: "stale projection",
        ts: 2,
        _turnOwnerId: "cm-live-restore",
      },
      {
        id: "server-error",
        role: "assistant",
        text: "",
        ts: 9,
        _source: "server",
        _turnTapeId: "tape-crashed",
        _clientMessageId: "cm-live-restore",
        _errorCode: "service_restart",
      },
    );
    const record = (recordId: string, frameSeq: number, blocks: unknown[]) => ({
      recordId,
      streamKey: "dispatch:11111111-1111-4111-8111-111111111111:1",
      source: "gateway" as const,
      clientMessageId: "cm-live-restore",
      payload: {
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s-live-restore",
        frameSeq,
        peer: { id: "s-live-restore", kind: "dm" },
        clientMessageId: "cm-live-restore",
        blocks,
        isFinal: false,
        ts: frameSeq + 10,
      },
    });

    sock.applyDurableLiveFrames(
      "s-live-restore",
      [record("1", 1, [{ kind: "thinking", text: "exact thought" }])],
      ["cm-live-restore"],
    );
    sock.applyDurableLiveFrames(
      "s-live-restore",
      [
        record("2", 2, [{
          kind: "tool_use",
          blockId: "call-1",
          toolName: "exec_command",
          inputJson: { cmd: "echo exact" },
          partial: false,
        }]),
        record("3", 3, [{
          kind: "tool_result",
          blockId: "result-call-1",
          toolUseBlockId: "call-1",
          toolName: "exec_command",
          isError: false,
          output: "exact output",
        }]),
        record("4", 4, [{ kind: "text", text: "exact partial answer" }]),
      ],
    );

    expect(session.messages.find((message) => message.id === "stale-client-thinking")).toBeUndefined();
    expect(session.messages.find((message) => message.id === "cm-live-restore")?.text).toBe("long task");
    expect(session.messages.find((message) => message.id === "server-error")?._turnTapeId).toBe("tape-crashed");
    expect(session.messages.some((message) => message.role === "thinking" && message.text === "exact thought")).toBe(true);
    expect(session.messages.some((message) => message.role === "tool" && message.output === "exact output")).toBe(true);
    expect(session.messages.some((message) => message.role === "assistant" && message.text === "exact partial answer")).toBe(true);
    expect(persisted).toEqual(["s-live-restore", "s-live-restore"]);
    sock.stop();
  });

  test("journal page1 → overlapping WS frame → page2 applies thinking/tool/text exactly once", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    const sessId = "s-live-overlap";
    const clientMessageId = "cm-live-overlap";
    const sessionKey = `agent:main:webchat:dm:${sessId}`;
    const session = sock.ensureSession(sessId, "main");
    session.messages.push({
      id: clientMessageId,
      role: "user",
      text: "long task",
      ts: 1,
      status: "sent",
    });
    session._lastFrameSeqByKey = { [sessionKey]: 99 };
    session._lastFrameSeq = 99;
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    const payload = (frameSeq: number, blocks: unknown[]) => ({
      type: "outbound.message",
      sessionKey,
      frameSeq,
      peer: { id: sessId, kind: "dm" },
      clientMessageId,
      blocks,
      isFinal: false,
      ts: frameSeq + 10,
    });
    const record = (recordId: string, frameSeq: number, blocks: unknown[]) => ({
      recordId,
      streamKey: "dispatch:22222222-2222-4222-8222-222222222222:1",
      source: "gateway" as const,
      clientMessageId,
      payload: payload(frameSeq, blocks),
    });
    const overlapBlocks = [
      {
        kind: "tool_use",
        blockId: "call-overlap",
        toolName: "exec_command",
        inputJson: { cmd: "echo once" },
        partial: false,
      },
      {
        kind: "tool_result",
        blockId: "result-call-overlap",
        toolUseBlockId: "call-overlap",
        toolName: "exec_command",
        isError: false,
        output: "tool output once",
      },
      { kind: "text", text: "answer once" },
    ];

    await sock.runDurableLiveFrameHydration(sessId, async () => {
      const page1 = record("1", 1, [{ kind: "thinking", text: "thought once" }]);
      // This live frame is committed after page1 and will also be returned by page2.
      ws.onmessage?.({ data: JSON.stringify(payload(2, overlapBlocks)) } as MessageEvent);
      const page2 = record("2", 2, overlapBlocks);
      sock.applyDurableLiveFrames(sessId, [page1, page2], [clientMessageId]);
    });

    expect(session.messages.filter((m) => m.role === "thinking" && m.text === "thought once")).toHaveLength(1);
    expect(session.messages.filter((m) => m.role === "tool" && m.output === "tool output once")).toHaveLength(1);
    expect(session.messages.filter((m) => m.role === "assistant" && m.text === "answer once")).toHaveLength(1);
    expect(session._lastFrameSeqByKey?.[sessionKey]).toBe(2);
    sock.stop();
  });

  test("automatic checkpoint keeps the exact old tape and skipped ACK removes only its optimistic child", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ syncSession: async () => {} });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const session = sock.ensureSession("s-auto-checkpoint", "main");
    session.messages.push(
      {
        id: "u-auto-checkpoint",
        role: "user",
        text: "long task",
        ts: 1,
        status: "error",
        _source: "server",
        _routing: { model: "kimi-k3-ark", teamMode: false, effortLevel: "high" },
      },
      {
        id: "thinking-auto-checkpoint",
        role: "thinking",
        text: "finished step 1",
        ts: 2,
        _source: "server",
        _turnTapeId: "tape-auto-checkpoint",
        _clientMessageId: "u-auto-checkpoint",
      },
      {
        id: "error-auto-checkpoint",
        role: "assistant",
        text: "",
        ts: 3,
        _source: "server",
        _turnTapeId: "tape-auto-checkpoint",
        _clientMessageId: "u-auto-checkpoint",
        _errorCode: "model_capacity",
      },
    );
    const oldRows = structuredClone(session.messages);
    await (sock as any).autoRecoverTerminalTurn(
      "s-auto-checkpoint",
      "u-auto-checkpoint",
    );
    await Promise.resolve();

    expect(session.messages.slice(0, oldRows.length)).toEqual([
      { ...oldRows[0], _automaticRecoveryAttempted: true },
      ...oldRows.slice(1),
    ]);
    const recovery = session.messages.at(-1)!;
    expect(recovery).toMatchObject({
      text: "↻ 自动从断点继续",
      _recoveryOfClientMessageId: "u-auto-checkpoint",
      _recoveryMode: "checkpoint",
      _automaticRecovery: true,
    });
    const wire = ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, any>)
      .find((payload) => payload.type === "inbound.message");
    expect(wire).toMatchObject({
      clientMessageId: recovery.id,
      content: {
        displayText: "↻ 自动从断点继续",
        recovery: {
          sourceClientMessageId: "u-auto-checkpoint",
          mode: "checkpoint",
          automatic: true,
          rootClientMessageId: "u-auto-checkpoint",
          attempt: 1,
          max: 10,
        },
      },
    });
    expect(wire?.content.media).toBeUndefined();

    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.ack",
        recoverySkipped: true,
        recoverySkippedReason: "source_not_latest",
        sourceClientMessageId: "u-auto-checkpoint",
        peer: { id: "s-auto-checkpoint", kind: "dm" },
        clientMessageId: recovery.id,
      }),
    });
    expect(session.messages).toEqual([
      { ...oldRows[0], _automaticRecoveryAttempted: true },
      ...oldRows.slice(1),
    ]);
    expect(session._sendingInFlight).toBe(false);
    const sentRecoveries = () => ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, any>)
      .filter((payload) => payload.type === "inbound.message").length;
    expect(sentRecoveries()).toBe(1);

    sock.applyServerMessages(
      "s-auto-checkpoint",
      "main",
      structuredClone(oldRows),
      true,
      undefined,
      { serverUpdatedAt: 10 },
    );
    expect(session.messages[0]._automaticRecoveryAttempted).toBe(true);
    await (sock as any).autoRecoverTerminalTurn(
      "s-auto-checkpoint",
      "u-auto-checkpoint",
    );
    await Promise.resolve();
    expect(sentRecoveries()).toBe(1);
    expect(sock.toStored("s-auto-checkpoint")?.messages[0]._automaticRecoveryAttempted).toBe(true);
    expect(sock.toStored("s-auto-checkpoint")?._automaticRecoveryDecisions?.["u-auto-checkpoint"]).toBe(true);
    sock.stop();
  });

  test("automatic replay uses the exact original prompt, attachment and reply only when no process exists", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ syncSession: async () => {} });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const session = sock.ensureSession("s-auto-replay", "main");
    session.messages.push(
      {
        id: "u-auto-replay",
        role: "user",
        text: "visible original",
        ts: 1,
        status: "error",
        _source: "server",
        _modelText: "model original",
        _media: [{ kind: "image", url: "https://example.test/source.png" }],
        _replyTo: { messageId: "answer-1", role: "assistant", text: "quoted" },
        _routing: { model: "kimi-k3-ark", teamMode: true, effortLevel: null },
      },
      {
        id: "error-auto-replay",
        role: "assistant",
        text: "",
        ts: 2,
        _source: "server",
        _turnTapeId: "tape-auto-replay",
        _clientMessageId: "u-auto-replay",
        _errorCode: "upstream_timeout",
      },
    );
    await (sock as any).autoRecoverTerminalTurn("s-auto-replay", "u-auto-replay");
    await Promise.resolve();
    const wire = ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, any>)
      .find((payload) => payload.type === "inbound.message");
    expect(wire).toMatchObject({
      teamMode: true,
      content: {
        text: "model original",
        displayText: "↻ 自动重试",
        media: [{ kind: "image", url: "https://example.test/source.png" }],
        replyTo: { messageId: "answer-1", role: "assistant", text: "quoted" },
        recovery: {
          sourceClientMessageId: "u-auto-replay",
          mode: "replay",
          automatic: true,
          rootClientMessageId: "u-auto-replay",
          attempt: 1,
          max: 10,
        },
      },
    });
    sock.stop();
  });

  test("historical non-tail error persists a no-recovery decision before sync", async () => {
    const syncSession = vi.fn();
    const persistSession = vi.fn();
    const sock = makeSocket({ syncSession, persistSession });
    const session = sock.ensureSession("s-historical-error", "main");
    session.messages.push(
      {
        id: "u-historical-error",
        role: "user",
        text: "old task",
        ts: 1,
        status: "error",
        _source: "server",
        _routing: { model: "kimi-k3-ark", teamMode: false, effortLevel: null },
      },
      {
        id: "error-historical-error",
        role: "assistant",
        text: "",
        ts: 2,
        _source: "server",
        _turnTapeId: "tape-historical-error",
        _clientMessageId: "u-historical-error",
        _errorCode: "upstream_failed",
      },
      {
        id: "u-newer",
        role: "user",
        text: "new task",
        ts: 3,
        status: "sent",
        _source: "server",
      },
    );

    await (sock as any).autoRecoverTerminalTurn("s-historical-error", "u-historical-error");
    await (sock as any).autoRecoverTerminalTurn("s-historical-error", "u-historical-error");

    expect(syncSession).not.toHaveBeenCalled();
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(session._automaticRecoveryDecisions?.["u-historical-error"]).toBe(true);
    expect(session.messages).toHaveLength(3);
    sock.stop();
  });

  test("user Stop persistently fences automatic recovery even after server history sync", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ syncSession: async () => {} });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s-stop-recovery",
      agentId: "main",
      text: "long task",
      model: "kimi-k3-ark",
    });
    const session = sock.sessions.get("s-stop-recovery")!;
    const user = session.messages.find((message) => message.role === "user")!;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s-stop-recovery", kind: "dm" },
      clientMessageId: user.id,
    }) });
    sock.stopTurn("s-stop-recovery");
    ws.sent.length = 0;

    user._source = "server";
    user.status = "error";
    session.messages.push(
      {
        id: "thinking-after-stop",
        role: "thinking",
        text: "partial",
        ts: 2,
        _source: "server",
        _turnTapeId: "tape-after-stop",
        _clientMessageId: user.id,
      },
      {
        id: "error-after-stop",
        role: "assistant",
        text: "",
        ts: 3,
        _source: "server",
        _turnTapeId: "tape-after-stop",
        _clientMessageId: user.id,
        _errorCode: "model_capacity",
      },
    );
    await (sock as any).autoRecoverTerminalTurn("s-stop-recovery", user.id);
    expect(ws.sent.some((raw) => JSON.parse(raw).type === "inbound.message")).toBe(false);

    const stored = sock.toStored("s-stop-recovery")!;
    expect(stored._cancelledAutomaticRecoveryIds?.[user.id]).toBe(true);
    const reloaded = makeSocket();
    reloaded.loadStored(stored);
    expect(
      reloaded.sessions.get("s-stop-recovery")?._cancelledAutomaticRecoveryIds?.[user.id],
    ).toBe(true);
    sock.stop();
    reloaded.stop();
  });
});

describe("ChatSocket 1008 auth recovery", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("transient refresh keeps auth, retries while disconnected, then reconnects on success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    let token = "expired-token";
    const expired = vi.fn();
    const silentRefresh = vi
      .fn<ChatSocketDeps["silentRefresh"]>()
      .mockResolvedValueOnce({ kind: "transient", epoch: 7, retryAfterMs: 500 })
      .mockImplementationOnce(async () => {
        token = "fresh-token";
        return { kind: "success", epoch: 7, result: { accessToken: token, accessExp: 999, remember: true } };
      });
    const sock = makeSocket({
      getToken: () => token,
      getAuthEpoch: () => 7,
      silentRefresh,
      onAuthExpired: expired,
    });
    sock.setGateReady(true);
    const first = FakeWS.instances.at(-1)!;
    first.readyState = 3;
    first.onclose?.({ code: 1008, reason: "expired" });
    await Promise.resolve();

    expect(expired).not.toHaveBeenCalled();
    expect(FakeWS.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(silentRefresh).toHaveBeenCalledTimes(2);
    expect(expired).not.toHaveBeenCalled();
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1].protocols).toEqual(["bearer", "fresh-token"]);
    sock.stop();
  });

  test("explicit invalid refresh tears auth down exactly once", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const expired = vi.fn();
    const sock = makeSocket({
      getAuthEpoch: () => 3,
      silentRefresh: async () => ({ kind: "invalid", epoch: 3 }),
      onAuthExpired: expired,
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.readyState = 3;
    ws.onclose?.({ code: 1008, reason: "expired" });
    await Promise.resolve();
    await Promise.resolve();

    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith(3);
    expect(FakeWS.instances).toHaveLength(1);
    sock.stop();
  });

  test("stop cancels a scheduled transient auth retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const silentRefresh = vi.fn(async (epoch: number) => ({ kind: "transient" as const, epoch, retryAfterMs: 500 }));
    const sock = makeSocket({ getAuthEpoch: () => 2, silentRefresh });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.readyState = 3;
    ws.onclose?.({ code: 1008, reason: "expired" });
    await Promise.resolve();
    sock.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(silentRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSocket GoalState reconnect recovery", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("every successful socket open refreshes the selected PG goal authority", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncGoalState = vi.fn<NonNullable<ChatSocketDeps["syncGoalState"]>>();
    const sock = makeSocket({ syncGoalState });
    sock.ensureSession("s-goal-reconnect", "main");
    sock.setActiveSession("s-goal-reconnect");
    sock.setGateReady(true);
    FakeWS.instances.at(-1)!.open();
    await Promise.resolve();
    expect(syncGoalState).toHaveBeenCalledTimes(1);
    expect(syncGoalState).toHaveBeenCalledWith("s-goal-reconnect");
    sock.stop();
  });
});

describe("ChatSocket safeWsSend backpressure (§2) + offline enqueue (§10)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("exact payload is durably journaled before physical send and cleared only by admitted ACK", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    let releaseFirst!: () => void;
    const firstCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const persistPendingDispatch = vi.fn()
      .mockImplementationOnce(() => firstCommit)
      .mockResolvedValue(undefined);
    const deletePendingDispatch = vi.fn().mockResolvedValue(undefined);
    const sock = makeSocket({ persistPendingDispatch, deletePendingDispatch });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "must survive reload" });
    const user = sock.sessions.get("s1")!.messages.find((message) => message.role === "user")!;
    expect(persistPendingDispatch).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ msgId: user.id, payload: expect.objectContaining({ clientMessageId: user.id }) }),
    );
    expect(ws.sent.some((raw) => JSON.parse(raw).type === "inbound.message")).toBe(false);

    releaseFirst();
    await vi.waitFor(() => expect(ws.sent.some((raw) => {
      const frame = JSON.parse(raw);
      return frame.type === "inbound.message" && frame.clientMessageId === user.id;
    })).toBe(true));
    expect(user.status).toBe("sending");
    expect(sock.sessions.get("s1")?._sendingInFlight).toBeFalsy();

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: user.id,
    }) });
    expect(deletePendingDispatch).toHaveBeenCalledWith("s1", user.id);
    expect(user.status).toBe("sent");
    expect(sock.sessions.get("s1")?._sendingInFlight).toBe(true);
  });

  test("pending reconnect status promotes only after every journal item is admitted", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "first peer" });
    sock.sendMessage({ sessId: "s2", agentId: "main", text: "second peer" });
    const firstId = sock.sessions.get("s1")!.messages.find((message) => message.role === "user")!.id;
    const secondId = sock.sessions.get("s2")!.messages.find((message) => message.role === "user")!.id;

    ws.open();
    await vi.waitFor(() => expect(sock.getSnapshot().status)
      .toEqual({ label: "补发离线消息… (2)", cls: "connecting" }));
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: firstId,
    }) });
    await vi.waitFor(() => expect(sock.getSnapshot().status.cls).toBe("connecting"));

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s2", kind: "dm" },
      clientMessageId: secondId,
    }) });
    await vi.waitFor(() => expect(sock.getSnapshot().status)
      .toEqual({ label: "已连接", cls: "connected" }));
  });

  test("relay ready promotes after the last pending item was cleared before relay attachment", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "already converged" });

    ws.readyState = 1;
    ws.onopen?.();
    await vi.waitFor(() => expect(sock.getSnapshot().status.cls).toBe("connecting"));
    sock.removeSession("s1");
    expect(sock.getSnapshot().status.cls).toBe("connecting");

    ws.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
    await vi.waitFor(() => expect(sock.getSnapshot().status)
      .toEqual({ label: "已连接", cls: "connected" }));
  });

  test("journal storage failure sends once with neutral confirmation until durable admission", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    let rejectCommit!: (error: Error) => void;
    const failedCommit = new Promise<void>((_resolve, reject) => { rejectCommit = reject; });
    const persistPendingDispatch = vi.fn(() => failedCommit);
    const sock = makeSocket({ persistPendingDispatch });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "wait for safe storage" });
    const user = sock.sessions.get("s1")!.messages.find((message) => message.role === "user")!;
    rejectCommit(new Error("quota"));
    await vi.waitFor(() => expect(ws.sent.filter((raw) => {
      const frame = JSON.parse(raw);
      return frame.type === "inbound.message" && frame.clientMessageId === user.id;
    })).toHaveLength(1));
    expect(persistPendingDispatch).toHaveBeenCalledTimes(1);
    expect(sock.getTransientNotice("s1")?.text).toBe("正在确认发送…");
    expect(sock.getTransientNotice("s1")?.text).not.toContain("浏览器");
    expect(user.status).toBe("sending");
    expect(sock.sessions.get("s1")?._sendingInFlight).toBeFalsy();
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: user.id,
    }) });
    expect(user.status).toBe("sent");
    expect(sock.sessions.get("s1")?._sendingInFlight).toBe(true);
    expect(sock.getTransientNotice("s1")).toBeNull();
  });

  test("journal-less unadmitted send reconnects with the exact same identity", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const persistPendingDispatch = vi.fn().mockRejectedValue(new Error("storage disabled"));
    const sock = makeSocket({ persistPendingDispatch });
    sock.setGateReady(true);
    const first = FakeWS.instances.at(-1)!;
    first.open();

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "same logical send" });
    await vi.waitFor(() => expect(first.sent.some((raw) =>
      JSON.parse(raw).type === "inbound.message")).toBe(true));
    const firstFrame = first.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");

    first.close(1006, "network lost before ack");
    sock.connect();
    const second = FakeWS.instances.at(-1)!;
    second.open();
    await vi.waitFor(() => expect(second.sent.filter((raw) =>
      JSON.parse(raw).type === "inbound.message")).toHaveLength(1));
    const replay = second.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");
    expect(replay.clientMessageId).toBe(firstFrame.clientMessageId);
    expect(replay.idempotencyKey).toBe(firstFrame.idempotencyKey);
  });

  test("a pending journal commit survives reconnect without a racing second attempt", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const persistPendingDispatch = vi.fn(() => commit);
    const sock = makeSocket({ persistPendingDispatch });
    sock.setGateReady(true);
    const first = FakeWS.instances.at(-1)!;
    first.open();

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "one logical send" });
    first.close(1006, "network lost");
    sock.connect();
    const second = FakeWS.instances.at(-1)!;
    second.open();
    expect(persistPendingDispatch).toHaveBeenCalledTimes(1);
    expect(second.sent.some((raw) => JSON.parse(raw).type === "inbound.message")).toBe(false);

    releaseCommit();
    await vi.waitFor(() => expect(second.sent.filter((raw) =>
      JSON.parse(raw).type === "inbound.message")).toHaveLength(1));
    expect(persistPendingDispatch).toHaveBeenCalledTimes(1);
    expect(first.sent.some((raw) => JSON.parse(raw).type === "inbound.message")).toBe(false);
  });

  test("active stop/start replays one physically-sent unadmitted turn exactly once", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const first = FakeWS.instances.at(-1)!;
    first.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "survive active stop" });
    const firstFrame = first.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");

    sock.stop();
    sock.start();
    sock.connect();
    const second = FakeWS.instances.at(-1)!;
    second.open();
    const replayed = second.sent.map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "inbound.message");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].clientMessageId).toBe(firstFrame.clientMessageId);
    expect(replayed[0].idempotencyKey).toBe(firstFrame.idempotencyKey);
  });

  test("gate close/open replays one physically-sent unadmitted turn exactly once", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const first = FakeWS.instances.at(-1)!;
    first.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "survive gate close" });
    const firstFrame = first.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");

    sock.setGateReady(false);
    sock.setGateReady(true);
    const second = FakeWS.instances.at(-1)!;
    second.open();
    const replayed = second.sent.map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "inbound.message");
    expect(replayed).toHaveLength(1);
    expect(replayed[0].clientMessageId).toBe(firstFrame.clientMessageId);
    expect(replayed[0].idempotencyKey).toBe(firstFrame.idempotencyKey);
  });

  test("admission keeps the peer FIFO slot until exact final, then sends the next prompt", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "first" });
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "second" });
    const users = sock.sessions.get("s1")!.messages.filter((message) => message.role === "user");
    const inbound = () => ws.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "inbound.message");
    expect(inbound().map((frame) => frame.content.text)).toEqual(["first"]);

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: users[0]!.id,
    }) });
    expect(inbound().map((frame) => frame.content.text)).toEqual(["first"]);

    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 1,
      clientMessageId: users[0]!.id,
      blocks: [{ kind: "text", text: "done" }],
      isFinal: true,
    })) });
    expect(inbound().map((frame) => frame.content.text)).toEqual(["first", "second"]);
  });

  test("reload restores an unacknowledged exact dispatch with the same identity", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const original = makeSocket();
    original.setGateReady(true);
    const firstWs = FakeWS.instances.at(-1)!;
    firstWs.open();
    original.sendMessage({ sessId: "s1", agentId: "main", text: "recover me" });
    const stored = original.toStored("s1")!;
    const pending = original.offlineQueue[0]!;
    const originalFrame = firstWs.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");

    const restored = makeSocket();
    restored.loadStored({
      ...stored,
      _pendingDispatches: [{
        msgId: pending.msgId,
        payload: pending.payload,
        enqueuedAt: pending.enqueuedAt,
      }],
    });
    restored.setGateReady(true);
    const secondWs = FakeWS.instances.at(-1)!;
    secondWs.open();
    const replay = secondWs.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");
    expect(replay.clientMessageId).toBe(originalFrame.clientMessageId);
    expect(replay.idempotencyKey).toBe(originalFrame.idempotencyKey);
    expect(replay.content).toEqual(originalFrame.content);
  });

  test("send while ws OPEN → ws.send called, msg sent, in-flight", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // connect
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const inbound = ws.sent.find((d) => d.includes('"inbound.message"'));
    expect(inbound).toBeTruthy();
    const s = sock.sessions.get("s1")!;
    const user = s.messages.find((m) => m.role === "user")!;
    const payload = JSON.parse(inbound!);
    expect(payload.clientMessageId).toBe(user.id);
    expect(payload.idempotencyKey).toBe(messageAttemptIdempotencyKey(user.id, 0));
    expect(user._sendAttempt).toBe(0);
    expect(s._activeClientMessageId).toBe(user.id);
    expect(s._sendingInFlight).toBeFalsy();
    expect(user.status).toBe("sending");
    // Browser-only residue must be replaced at the first authoritative
    // admission of a new root turn, not carried into its reminder.
    s._turnCostCredits = "999";
    s._turnCostSeenRequestIds = new Set(["old-request"]);
    s._turnCostReminderCredits = "999";
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: user.id,
    }) });
    expect(s._sendingInFlight).toBe(true);
    expect(user.status).toBe("sent");
    expect(s._turnCostCredits).toBe("0");
    expect(s._turnCostSeenRequestIds?.size).toBe(0);
    expect(s._turnCostReminderCredits).toBeUndefined();
  });

  test("cost_waived 同时刷新余额与站内信未读角标", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const refreshBalance = vi.fn();
    const refreshInbox = vi.fn();
    const sock = makeSocket({ refreshBalance, refreshInbox });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.cost_waived",
      sessionId: "s1",
      turnKey: "9".repeat(64),
      refundedCredits: "259",
      balanceAfter: "1234",
      reason: "platform_authority_expired",
      inboxMessageId: "901",
    }) });

    expect(refreshBalance).toHaveBeenCalledTimes(1);
    expect(refreshInbox).toHaveBeenCalledTimes(1);
  });

  test("annotated image sends hidden source/mask to gateway but only shows the guide in the user bubble", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "把杯子改成玻璃杯",
      media: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/mask.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png" },
      ],
      imageEdit: { clientJobId: "a".repeat(32), sourceIndex: 0, maskIndex: 1, guideIndex: 2, width: 100, height: 80 },
    });
    const inbound = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.message");
    expect(inbound.content.media).toHaveLength(3);
    expect(inbound.content.imageEdit).toMatchObject({ sourceIndex: 0, maskIndex: 1, guideIndex: 2 });
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?._media).toEqual([
      { kind: "image", url: "/api/media/guide.png" },
    ]);
    const user = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!;
    user.status = "error";
    sock.sessions.get("s1")!._sendingInFlight = false;
    sock.retryMessage({ sessId: "s1", msgId: user.id, agentId: "main" });
    const retried = ws.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "inbound.message").at(-1);
    expect(retried.content.media).toHaveLength(3);
    expect(retried.content.imageEdit.clientJobId).toBe("a".repeat(32));
  });

  test("lazy oversized user retries from the exact sidecar source without hydrating the hot locator", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.ensureSession("s1", "main");
    const session = sock.sessions.get("s1")!;
    const locator = addMessage(session, "user", "", {
      status: "error",
      _userPayloadDeferred: true,
      _payloadDeferred: true,
      _payloadBytes: 8_000_000,
      _payloadSha256: "a".repeat(64),
      _routing: { model: "gpt-5.6-terra", teamMode: true, effortLevel: "max" },
      _deferredRetryEligible: true,
      _sendAttempt: 0,
    });
    const imageEdit = {
      clientJobId: "b".repeat(32),
      sourceIndex: 0,
      maskIndex: 1,
      guideIndex: 2,
      width: 100,
      height: 80,
    } as const;
    const exact: ChatMessage = {
      ...locator,
      text: "用户看到的原始问题",
      _modelText: "用户看到的原始问题\n[完整模型附件提示]",
      _media: [{ kind: "image", url: "/api/media/guide.png" }],
      _retryMedia: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/mask.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png" },
      ],
      _imageEdit: imageEdit,
      _userPayloadDeferred: undefined,
      _payloadDeferred: undefined,
    };

    expect(exactUserReplayPayload(exact)).toMatchObject({
      text: "用户看到的原始问题\n[完整模型附件提示]",
      displayText: "用户看到的原始问题",
      imageEdit,
    });
    sock.retryMessage({
      sessId: "s1",
      msgId: locator.id,
      agentId: "main",
      sourceOverride: exact,
    });

    const retried = ws.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "inbound.message")
      .at(-1);
    expect(retried).toMatchObject({
      model: "gpt-5.6-terra",
      effortLevel: "max",
      teamMode: true,
      content: {
        text: "用户看到的原始问题\n[完整模型附件提示]",
        displayText: "用户看到的原始问题",
        imageEdit,
      },
    });
    expect(retried.content.media).toHaveLength(3);
    const stored = sock.toStored("s1")!.messages.find((message) => message.id === locator.id)!;
    expect(stored.text).toBe("");
    expect(stored._media).toBeUndefined();
    expect(stored._retryMedia).toBeUndefined();
    expect(stored._modelText).toBeUndefined();
    expect(stored._userPayloadDeferred).toBe(true);
  });

  test("optimistic localSrc: 气泡保留本地 blob 即时渲染,出站帧 + 持久化显式剥离", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "看这张图",
      media: [{ kind: "image", url: "/api/media/x.png", localSrc: "blob:preview", filename: "x.png" }],
    });
    // 乐观气泡保留 localSrc → 上传成功即渲(不等服务端回显/签名)。
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?._media).toEqual([
      { kind: "image", url: "/api/media/x.png", localSrc: "blob:preview", filename: "x.png" },
    ]);
    // 出站帧剥离 localSrc:blob: URL 换端/刷新即死,不该进 server 历史污染回显。
    const inbound = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.message");
    expect(inbound.content.media).toEqual([{ kind: "image", url: "/api/media/x.png", filename: "x.png" }]);
    // 持久化(IndexedDB)同样剥离 → reload 后媒体回落 url 走签名管线(needsSignedSrc)。
    const stored = sock.toStored("s1")!;
    expect(stored.messages.find((m) => m.role === "user")?._media).toEqual([
      { kind: "image", url: "/api/media/x.png", filename: "x.png" },
    ]);
  });

  test("WS admission payload carries the complete replay contract, including hidden image-edit refs", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ ensureServerSession: async () => true });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const imageEdit = {
      clientJobId: "c".repeat(32),
      sourceIndex: 0,
      maskIndex: 1,
      guideIndex: 2,
      width: 100,
      height: 80,
    } as const;
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "模型正文\n[附件提示]",
      displayText: "模型正文",
      media: [
        { kind: "image", url: "/api/media/source.png", hidden: true },
        { kind: "image", url: "/api/media/mask.png", hidden: true },
        { kind: "image", url: "/api/media/guide.png", localSrc: "blob:guide" },
      ],
      imageEdit,
      model: "gpt-5.6-sol",
      effortLevel: "high",
      teamMode: true,
    });
    const inbound = ws.sent.map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");
    expect(inbound).toMatchObject({
      content: {
        text: "模型正文\n[附件提示]",
        displayText: "模型正文",
        imageEdit,
        media: [
          { kind: "image", url: "/api/media/source.png", hidden: true },
          { kind: "image", url: "/api/media/mask.png", hidden: true },
          { kind: "image", url: "/api/media/guide.png" },
        ],
      },
      model: "gpt-5.6-sol",
      effortLevel: "high",
      teamMode: true,
    });
    const stored = sock.toStored("s1")!.messages.find((message) => message.role === "user")!;
    expect(stored).toMatchObject({
      text: "模型正文",
      _modelText: "模型正文\n[附件提示]",
      _routing: { model: "gpt-5.6-sol", effortLevel: "high", teamMode: true },
      _imageEdit: imageEdit,
      _sendAttempt: 0,
    });
  });

  test("reply snapshot is sent and cached once without duplicating it into current model text", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket({ ensureServerSession: async () => true });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const replyTo = {
      messageId: "assistant-exact",
      role: "assistant" as const,
      text: "完整历史回答",
    };
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "请解释这一段",
      replyTo,
    });

    const inbound = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.message");
    expect(inbound.content).toEqual({ text: "请解释这一段", replyTo });
    expect(inbound.replyToId).toBe(replyTo.messageId);

    const user = sock.sessions.get("s1")!.messages.find((message) => message.role === "user")!;
    expect(user).toMatchObject({ text: "请解释这一段", _replyTo: replyTo });
    expect(user._modelText).toBeUndefined();
    expect(sock.toStored("s1")!.messages.find((message) => message.role === "user")).toMatchObject({
      text: "请解释这一段",
      _replyTo: replyTo,
    });
  });

  test("send caches optimistic user row but starts in-flight only after admission", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const persistSession = vi.fn();
    const sock = makeSocket({ persistSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(persistSession).toHaveBeenCalledWith("s1");
    const stored = sock.toStored("s1")!;
    expect(stored.messages.find((m) => m.role === "user")).toMatchObject({
      text: "hi",
      _sendAttempt: 0,
    });
    expect(stored._sendingInFlight).toBeUndefined();
    const userId = stored.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: userId,
    }) });
    expect(sock.toStored("s1")).toMatchObject({
      _sendingInFlight: true,
      _activeClientMessageId: userId,
    });
    expect(typeof sock.toStored("s1")?._turnStartedAt).toBe("number");
  });

  test("retry preserves the failed turn model, effort, and team routing snapshot", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "hi",
      model: "gpt-5.6-terra",
      effortLevel: "max",
      teamMode: true,
    });
    const session = sock.sessions.get("s1")!;
    const userMessage = session.messages.find((message) => message.role === "user")!;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.error", peer: { id: "s1", kind: "dm" }, clientMessageId: userMessage.id,
      code: "upstream_failed", message: "failed", frameSeq: 1, ts: 1,
    }) });

    // A later turn overwrites the session snapshot. Retrying the earlier failed row must
    // still use that row's original routing, not the newest turn's selection.
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "later",
      model: "gpt-5.6-sol",
      effortLevel: "low",
      teamMode: false,
    });
    sock.stopTurn("s1");

    sock.retryMessage({ sessId: "s1", msgId: userMessage.id, agentId: "main" });

    const retry = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((payload) => payload.clientMessageId === userMessage.id && typeof payload.idempotencyKey === "string" && payload.idempotencyKey.endsWith(":1"));
    expect(retry.idempotencyKey).toBe(messageAttemptIdempotencyKey(userMessage.id, 1));
    expect(retry).toMatchObject({
      model: "gpt-5.6-terra",
      effortLevel: "max",
      teamMode: true,
    });
    expect(session._lastRouting).toEqual({
      model: "gpt-5.6-terra",
      effortLevel: "max",
      teamMode: true,
    });
  });

  test("retry migrates a persisted GPT-5.5 routing snapshot to Sol", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "old turn" });
    const session = sock.sessions.get("s1")!;
    const userMessage = session.messages.find((message) => message.role === "user")!;
    userMessage._routing = undefined;
    session._lastRouting = { model: "gpt-5.5", effortLevel: "high", teamMode: true };
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.error", peer: { id: "s1", kind: "dm" }, clientMessageId: userMessage.id,
      code: "upstream_failed", message: "failed", frameSeq: 1, ts: 1,
    }) });

    sock.retryMessage({ sessId: "s1", msgId: userMessage.id, agentId: "main" });

    const retry = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((payload) => payload.clientMessageId === userMessage.id && typeof payload.idempotencyKey === "string" && payload.idempotencyKey.endsWith(":1"));
    expect(retry.idempotencyKey).toBe(messageAttemptIdempotencyKey(userMessage.id, 1));
    expect(retry).toMatchObject({
      model: "gpt-5.6-sol",
      effortLevel: "high",
      teamMode: true,
    });
    expect(session._lastRouting?.model).toBe("gpt-5.6-sol");
    expect((userMessage as ChatMessage)._routing?.model).toBe("gpt-5.6-sol");
  });

  test("retry preserves explicit null effort so a warm runner returns to the model default", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "reset effort",
      model: "gpt-5.6-sol",
      effortLevel: null,
    });
    const session = sock.sessions.get("s1")!;
    const userMessage = session.messages.find((message) => message.role === "user")!;
    expect(userMessage._routing?.effortLevel).toBeNull();
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.error", peer: { id: "s1", kind: "dm" }, clientMessageId: userMessage.id,
      code: "upstream_failed", message: "failed", frameSeq: 1, ts: 1,
    }) });

    sock.retryMessage({ sessId: "s1", msgId: userMessage.id, agentId: "main" });

    const retry = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((payload) => payload.clientMessageId === userMessage.id && typeof payload.idempotencyKey === "string" && payload.idempotencyKey.endsWith(":1"));
    expect(retry.idempotencyKey).toBe(messageAttemptIdempotencyKey(userMessage.id, 1));
    expect(retry).toMatchObject({ model: "gpt-5.6-sol", effortLevel: null });
  });

  test("生成中(busy)再发 → Stop 保留但暂停 queued；下一次显式发送才恢复 FIFO", async () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    // 第一条:正常直发 → in-flight。
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "first" });
    const s = sock.sessions.get("s1")!;
    const firstId = s.messages.find((message) => message.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId: firstId,
    }) });
    expect(s._sendingInFlight).toBe(true);
    const inboundAfterFirst = ws.sent.filter((d) => d.includes('"inbound.message"')).length;
    expect(inboundAfterFirst).toBe(1);

    // 第二条:生成中 → 入本地队列标 queued,**不并轨直发**(防 mid-turn 并发 + 重复计费)。
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "second" });
    expect(s.messages.find((m) => m.text === "second")?.status).toBe("queued");
    expect(ws.sent.filter((d) => d.includes('"inbound.message"')).length).toBe(1);

    // 用户 Stop 只停止当前轮，后面的手动消息保留但绝不自动发出。
    sock.stopTurn("s1");
    expect(s._sendingInFlight).toBeFalsy();
    expect(ws.sent.some((d) => d.includes('"inbound.message"') && d.includes("second"))).toBe(false);
    expect(s.messages.find((m) => m.text === "second")?.status).toBe("queued");
    expect(sock.toStored("s1")?._dispatchPaused).toBe(true);

    // 下一次用户主动发送是明确恢复动作：旧 queued 仍按 FIFO 先发，新消息排在后面。
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "third" });
    expect(ws.sent.some((d) => d.includes('"inbound.message"') && d.includes("second"))).toBe(true);
    expect(s.messages.find((m) => m.text === "second")?.status).toBe("sending");
    expect(s.messages.find((m) => m.text === "third")?.status).toBe("queued");
    sock.stop();
  });

  test("切换助手先用旧 agent + exact clientMessageId 停止原 turn", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "long task" });
    const s = sock.sessions.get("s1")!;
    const clientMessageId = s.messages.find((message) => message.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId,
    }) });
    ws.sent.length = 0;

    sock.switchAgent("s1", "coding-assistant");

    const stop = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === "inbound.control.stop");
    expect(stop).toMatchObject({
      agentId: "main",
      clientMessageId,
      peer: { id: "s1", kind: "dm" },
    });
    expect(s.agentId).toBe("coding-assistant");
    expect(s._sendingInFlight).toBe(false);
    sock.stop();
  });

  test("restored in-flight session sends hello with inFlight=true", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    const now = Date.now();
    sock.loadStored({
      id: "s1",
      agentId: "main",
      title: "s1",
      messages: [{ id: "u1", role: "user", text: "hi", ts: now - 1000, status: "sent" }],
      createdAt: now - 1000,
      lastAt: now - 1000,
      _sendingInFlight: true,
      _turnStartedAt: now - 1000,
      _lastFrameAt: now - 500,
      _lastFrameSeqByKey: { "agent:main:webchat:dm:s1": 7 },
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const helloRaw = ws.sent.find((d) => d.includes('"inbound.hello"'));
    expect(helloRaw).toBeTruthy();
    const hello = JSON.parse(helloRaw!);
    expect(hello.peers[0]).toMatchObject({ peerId: "s1", agentId: "main", inFlight: true, lastFrameSeq: 7 });
    sock.stop();
  });

  test("rolling old IndexedDB substitution rows are discarded instead of mutating true records", () => {
    const sock = makeSocket();
    sock.loadStored({
      id: "s-history-patch",
      agentId: "main",
      title: "history",
      messages: [
        {
          id: "srv-tool",
          role: "tool",
          text: "Bash",
          ts: 1,
          blockId: "tool-bg",
        },
        {
          id: "projection-tail:runtime",
          role: "runtime-event",
          text: "",
          ts: 2,
          _seq: 9,
          _historyProjection: {
            kind: "bash-tail",
            toolUseId: "tool-bg",
            tail: "restored tail",
            totalBytes: 42,
            truncatedHead: false,
          },
        } as unknown as ChatMessage,
      ],
      createdAt: 1,
      lastAt: 2,
      _maxSeq: 9,
    });
    const restored = sock.sessions.get("s-history-patch")!.messages;
    expect(restored.map((message) => message.id)).toEqual(["srv-tool"]);
    expect(restored[0]!.bashTail).toBeUndefined();
  });

  test("hello names every trailing user-row candidate and ignores only an image placeholder", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    const now = Date.now();
    sock.loadStored({
      id: "s1",
      agentId: "main",
      title: "s1",
      messages: [
        { id: "srv-old", role: "assistant", text: "old", ts: now - 4 },
        { id: "m-user-1", role: "user", text: "running", ts: now - 3, status: "sent" },
        { id: "m-placeholder", role: "system", text: "", ts: now - 2, _genPlaceholder: {
          jobId: "a".repeat(32), aspect: 1, status: "running", startedAt: now - 2,
        } },
        { id: "m-user-2", role: "user", text: "queued", ts: now - 1, status: "queued" },
      ],
      createdAt: now - 4,
      lastAt: now - 1,
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const hello = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.hello");
    expect(hello.peers[0].resumeActiveTurnCandidateMessageIds).toEqual(["m-user-1", "m-user-2"]);
    sock.stop();
  });

  test("hello never advertises an exact turn already fenced by user Stop", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    const now = Date.now();
    sock.loadStored({
      id: "s1",
      agentId: "main",
      title: "s1",
      messages: [
        { id: "srv-old", role: "assistant", text: "old", ts: now - 3 },
        { id: "m-user-stopped", role: "user", text: "stopped", ts: now - 2, status: "sent" },
        { id: "m-user-running", role: "user", text: "running", ts: now - 1, status: "sent" },
      ],
      createdAt: now - 3,
      lastAt: now - 1,
      _cancelledAutomaticRecoveryIds: { "m-user-stopped": true },
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    const hello = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.hello");
    expect(hello.peers[0].resumeActiveTurnCandidateMessageIds).toEqual(["m-user-running"]);

    const restored = sock.sessions.get("s1")!;
    restored._lastFrameSeqByKey = { "agent:main:webchat:dm:s1": 42 };
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.active_turn_replay_start",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: "m-user-stopped",
    }) });
    expect(restored._lastFrameSeqByKey["agent:main:webchat:dm:s1"]).toBe(42);
    expect(sock.isSessionBusy("s1")).toBe(false);
    sock.stop();
  });

  test("hello keeps the oldest lock-owner candidate when a queued user block exceeds 32 rows", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    const now = Date.now();
    sock.loadStored({
      id: "s1",
      agentId: "main",
      title: "s1",
      messages: [
        { id: "srv-old", role: "assistant", text: "old", ts: now - 100 },
        ...Array.from({ length: 35 }, (_, i) => ({
          id: `m-user-${i}`,
          role: "user" as const,
          text: `queued ${i}`,
          ts: now - 35 + i,
          status: i === 0 ? "sent" as const : "queued" as const,
        })),
      ],
      createdAt: now - 100,
      lastAt: now,
    });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const hello = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.hello");
    const candidates = hello.peers[0].resumeActiveTurnCandidateMessageIds as string[];
    expect(candidates).toHaveLength(32);
    expect(candidates[0]).toBe("m-user-0");
    expect(candidates.slice(1)).toEqual(Array.from({ length: 31 }, (_, i) => `m-user-${i + 4}`));
    sock.stop();
  });

  test("shell miss → REST user row → verified active replay resets only then restores the full prefix", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const persistSession = vi.fn();
    const sock = makeSocket({ syncSession, persistSession });
    sock.ensureSession("s1", "main");
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const initialHello = ws.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "inbound.hello");
    expect(initialHello.peers[0].resumeActiveTurnCandidateMessageIds).toBeUndefined();

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.resume_failed",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      from: 0,
      to: 42,
      reason: "no_buffer",
    }) });
    expect(sock.sessions.get("s1")!._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    expect(syncSession).toHaveBeenCalledTimes(1);

    const user = { id: "m-user-running", role: "user", text: "long task", ts: 1, status: "sent" } as ChatMessage;
    sock.applyServerMessages("s1", "main", [user], true, 1);
    const targeted = ws.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === "inbound.hello")
      .at(-1);
    expect(targeted.peers[0]).toMatchObject({
      peerId: "s1",
      inFlight: false,
      lastFrameSeq: 42,
      resumeActiveTurnCandidateMessageIds: ["m-user-running"],
    });
    const helloCount = ws.sent.filter((raw) => raw.includes('"inbound.hello"')).length;
    sock.applyServerMessages("s1", "main", [user], true, 1);
    expect(ws.sent.filter((raw) => raw.includes('"inbound.hello"'))).toHaveLength(helloCount);

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.active_turn_replay_start",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: "m-user-running",
    }) });
    const active = sock.sessions.get("s1")!;
    expect(active._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(0);
    expect(active._activeClientMessageId).toBe("m-user-running");

    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 10,
      ts: 10,
      blocks: [{ kind: "text", text: "prefix restored" }],
    })) });
    expect(active.messages.some((m) => m.role === "assistant" && m.text === "prefix restored")).toBe(true);
    expect(active.messages.find((m) => m.role === "assistant")?._clientMessageId).toBe("m-user-running");
    expect(persistSession).toHaveBeenCalledWith("s1");
    sock.stop();
  });

  test("a replay-start already in flight cannot resurrect the exact turn after user Stop", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "long task" });
    const active = sock.sessions.get("s1")!;
    const clientMessageId = active.messages.find((message) => message.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId,
    }) });
    active._lastFrameSeqByKey = { "agent:main:webchat:dm:s1": 42 };

    sock.stopTurn("s1");
    const teardownAt = active._localTeardownAt;
    expect(active._cancelledAutomaticRecoveryIds?.[clientMessageId]).toBe(true);
    expect(sock.isSessionBusy("s1")).toBe(false);

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.active_turn_replay_start",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId,
    }) });
    expect(active._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    expect(active._activeClientMessageId).toBeUndefined();
    expect(active._localTeardownAt).toBe(teardownAt);
    expect(sock.isSessionBusy("s1")).toBe(false);

    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 43,
      ts: Date.now(),
      blocks: [{ kind: "text", text: "late after Stop" }],
    })) });
    expect(active.messages.some((message) => message.text === "late after Stop")).toBe(false);
    expect(sock.isSessionBusy("s1")).toBe(false);
    sock.stop();
  });

  test("a user Stop fence does not block a different exact active-turn replay", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.ensureSession("s1", "main");
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const active = sock.sessions.get("s1")!;
    active._cancelledAutomaticRecoveryIds = { "m-user-stopped": true };
    active._lastFrameSeqByKey = { "agent:main:webchat:dm:s1": 42 };

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.active_turn_replay_start",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: "m-user-new",
    }) });
    expect(active._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(0);
    expect(active._activeClientMessageId).toBe("m-user-new");
    expect(sock.isSessionBusy("s1")).toBe(true);
    sock.stop();
  });

  test("a real final triggers one exact sync; duplicate final frames cannot trigger a second", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "question" });
    const s = sock.sessions.get("s1")!;
    const clientMessageId = s.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 1,
      ts: 1,
      blocks: [{ kind: "text", text: "answer" }],
    })) });
    const final = JSON.stringify(msgFrame({ frameSeq: 2, ts: 2, blocks: [], isFinal: true }));
    ws.onmessage?.({ data: final });
    ws.onmessage?.({ data: final });
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId });
    expect(s._activeClientMessageId).toBeUndefined();
    expect(s.messages.find((m) => m.role === "assistant")?._clientMessageId).toBe(clientMessageId);
    sock.stop();
  });

  test("an error terminal syncs once, while interrupted and cron terminals never sync", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "will fail" });
    const failedId = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.error",
      sessionKey: "agent:main:webchat:dm:s1",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      clientMessageId: failedId,
      code: "upstream_failed",
      message: "upstream failed",
      isFinal: false,
      frameSeq: 1,
      ts: 1,
    }) });
    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 2,
      ts: 2,
      clientMessageId: failedId,
      blocks: [{ kind: "text", text: "[error] upstream failed" }],
      isFinal: true,
    })) });
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenLastCalledWith("s1", { clientMessageId: failedId });

    sock.sendMessage({ sessId: "s1", agentId: "main", text: "will be interrupted" });
    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 3,
      ts: 3,
      isFinal: true,
      meta: { interrupted: "service_restart" },
    })) });
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(sock.sessions.get("s1")!._activeClientMessageId).toBeUndefined();

    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 4,
      ts: 4,
      blocks: [{ kind: "text", text: "scheduled update" }],
      isFinal: true,
      cronJob: { label: "daily" },
    })) });
    expect(syncSession).toHaveBeenCalledTimes(1);
    sock.stop();
  });

  test("reconcile final performs its existing sync exactly once with exact turn identity", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "question" });
    const clientMessageId = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!.id;
    ws.onmessage?.({ data: JSON.stringify(msgFrame({
      frameSeq: 1,
      ts: 1,
      blocks: [],
      isFinal: true,
      meta: { reconcile: "turn_completed" },
    })) });
    expect(syncSession).toHaveBeenCalledTimes(1);
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId });
    sock.stop();
  });

  test("stopTurn clears and persists pending turn state immediately", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const persistSession = vi.fn();
    const sock = makeSocket({ persistSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    persistSession.mockClear();

    sock.stopTurn("s1");

    expect(sock.sessions.get("s1")!._sendingInFlight).toBe(false);
    const stored = sock.toStored("s1")!;
    expect(stored._sendingInFlight).toBeFalsy();
    expect(typeof stored._trackerResetAt).toBe("number");
    expect(stored._localTeardownAt).toBe(stored._trackerResetAt);
    expect(persistSession).toHaveBeenCalledWith("s1");
    expect(ws.sent.some((d) => d.includes('"inbound.control.stop"'))).toBe(true);

    const reloaded = makeSocket();
    reloaded.loadStored(stored);
    const restored = reloaded.sessions.get("s1")!;
    const onLiveFrame = vi.fn();
    applyOutboundMessage(
      restored,
      msgFrame({
        frameSeq: 1,
        ts: stored._trackerResetAt! + 1,
        blocks: [{ kind: "text", text: "stale after stop+refresh", messageId: "late" }],
      }),
      { onLiveFrame },
    );
    expect(restored._sendingInFlight).toBe(false);
    expect(restored.messages.some((m) => m.text === "stale after stop+refresh")).toBe(false);
    expect(onLiveFrame).not.toHaveBeenCalled();
  });

  test("deduplicated auto-continue ack clears and persists pending turn state", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const persistSession = vi.fn();
    const sock = makeSocket({ persistSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    const sess = sock.ensureSession("s1", "main");
    sess._sendingInFlight = true;
    sess.messages.push({
      id: "u-auto",
      role: "user",
      text: "继续",
      ts: 1,
      status: "sent",
      _isAutoRetry: true,
      _idem: "autocont-s1-u1",
    } as ChatMessage);

    ws.onmessage?.({ data: JSON.stringify({ type: "outbound.ack", deduplicated: true, idempotencyKey: "autocont-s1-u1" }) });

    expect(sess._sendingInFlight).toBe(false);
    expect(sock.toStored("s1")?._sendingInFlight).toBeFalsy();
    expect(persistSession).toHaveBeenCalledWith("s1");
  });

  test("scoped dedup ACK reconciles only its exact peer and client row", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const syncSession = vi.fn();
    const sock = makeSocket({ syncSession });
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "one" });
    sock.sendMessage({ sessId: "s2", agentId: "main", text: "two" });
    const first = sock.sessions.get("s1")!;
    const second = sock.sessions.get("s2")!;
    const firstId = first._activeClientMessageId!;
    const secondId = second._activeClientMessageId!;
    for (const [sessId, clientMessageId] of [["s1", firstId], ["s2", secondId]]) {
      ws.onmessage?.({ data: JSON.stringify({
        type: "outbound.ack",
        admitted: true,
        peer: { id: sessId, kind: "dm" },
        clientMessageId,
      }) });
    }

    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      deduplicated: true,
      idempotencyKey: messageAttemptIdempotencyKey(firstId, 0),
      peer: { id: "s1", kind: "dm" },
      clientMessageId: firstId,
    }) });

    expect(first._sendingInFlight).toBe(false);
    expect(first._activeClientMessageId).toBeUndefined();
    expect(second._sendingInFlight).toBe(true);
    expect(second._activeClientMessageId).toBe(secondId);
    expect(syncSession).toHaveBeenCalledWith("s1", { clientMessageId: firstId });
    expect(syncSession).not.toHaveBeenCalledWith("s2", expect.anything());
  });

  test("Fix B — cost_charged 带 parentSessionId → 精确路由到父会话(多会话并发下不丢)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    // 两条会话同时"活跃":父会话 s-parent 队长在飞;另一会话 s-other 正流式。
    // 旧 costTargetSession 启发式此时 ≥2 候选 → 返回 null → 委派 cost 丢展示(只刷余额)。
    const parent = sock.ensureSession("s-parent", "main");
    parent._sendingInFlight = true;
    const other = sock.ensureSession("s-other", "main");
    const streaming = { id: "a-other", role: "assistant" as const, text: "x", ts: 1, usage: {} } as ChatMessage;
    other.messages.push(streaming);
    other._streamingAssistant = streaming;

    // 委派 cost_charged:sessionId=委派引擎会话(前端无此会话),parentSessionId=父客户端会话。
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.cost_charged", sessionId: "engine-deleg", parentSessionId: "s-parent", costCredits: "12",
    }) });

    // 精确命中父会话 → 入队本轮 pending(在飞、无 streamingAssistant);绝不误挂到 s-other。
    expect(sock.sessions.get("s-parent")!._pendingCostCredits).toBe("12");
    expect(streaming.usage?.costCredits).toBeUndefined(); // 另一会话零污染
  });

  test("bufferedAmount ≥ 2MB → close(4000) + requeue offline (no silent drop)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    ws.bufferedAmount = 3 * 1024 * 1024; // 背压超阈值
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(ws.closed?.code).toBe(4000); // 主动 close 触发自愈链
    // 用户消息进离线队列（保序补发），UI 标 queued —— 绝不静默丢失。
    expect(sock.offlineQueue.length).toBe(1);
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?.status).toBe("queued");
  });

  test("ws not OPEN (connecting) → message enqueued offline, status queued", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // ws in CONNECTING(0)
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    expect(sock.offlineQueue.length).toBe(1);
    expect(sock.sessions.get("s1")!.messages.find((m) => m.role === "user")?.status).toBe("queued");
  });

  test("offline replay keeps attempt 0 and the exact original idempotency key", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // connecting: initial dispatch enters offline queue
    const ws = FakeWS.instances.at(-1)!;
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const userMessage = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!;
    const originalKey = messageAttemptIdempotencyKey(userMessage.id, 0);
    expect(sock.offlineQueue[0]!.payload.idempotencyKey).toBe(originalKey);
    expect(userMessage._sendAttempt).toBe(0);

    ws.open();
    const replay = ws.sent.map((raw) => JSON.parse(raw)).find((payload) =>
      payload.type === "inbound.message" && payload.clientMessageId === userMessage.id);
    expect(replay.idempotencyKey).toBe(originalKey);
    expect(userMessage._sendAttempt).toBe(0);
  });

  test("onclose requeues in-flight drain items at head, preserving order (§10)", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    // 离线两条 → close 前都在 queue。
    ws.bufferedAmount = 3 * 1024 * 1024;
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "one" });
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "two" });
    expect(sock.offlineQueue.map((i) => i.payload.content.text)).toEqual(["one", "two"]);
  });
});

// ═══════════════ 鉴权契约：bearer 子协议（非 ?token= 非 header，§auth）═══════════════
describe("ChatSocket bearer subprotocol auth (#4)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("connects with Sec-WebSocket-Protocol ['bearer', token], no token in URL", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true); // 触发 connect
    const ws = FakeWS.instances.at(-1)!;
    // 鉴权走子协议数组，绝不 ?token= / 绝不 header。
    expect(ws.protocols).toEqual(["bearer", "tok"]);
    expect(ws.url).not.toContain("tok");
    expect(ws.url).not.toContain("token");
    expect(ws.url.endsWith("/ws/user-chat-bridge")).toBe(true);
  });
});

// ═══════════════ cohort lane 就绪闸（P3 RFC D1）═══════════════
describe("ChatSocket laneReady gate (P3 RFC D1)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
  });

  test("默认 laneReady=true：setGateReady(true) 直接建连（既有行为回归保护）", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    expect(FakeWS.instances.length).toBe(1);
    sock.stop();
  });

  test("laneReady=false 阻断建连；lane 决策达成（setLaneReady(true)）后才建连", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setLaneReady(false); // lane 决策未达
    sock.setGateReady(true); // 容器就绪，但 lane 未决 → 不建 WS（防落错 slot）
    expect(FakeWS.instances.length).toBe(0);
    sock.setLaneReady(true); // lane 决策达成 → 上升沿触发建连
    expect(FakeWS.instances.length).toBe(1);
    sock.stop();
  });

  test("双闸缺一不连：laneReady 先到、gateReady 未就绪时 no-op，gateReady 到位才建", () => {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setLaneReady(false);
    sock.setLaneReady(true); // gateReady 仍 false → connect 内部 no-op
    expect(FakeWS.instances.length).toBe(0);
    sock.setGateReady(true); // 现在双闸就绪 → 建连
    expect(FakeWS.instances.length).toBe(1);
    sock.stop();
  });
});

// ═══════════════ §5 close 4503 server-hinted 退避（无 12 分钟死循环）═══════════════
describe("ChatSocket 4503 server-hinted reconnect (no 12-min loop)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("4503+retryAfterSec schedules a single reconnect at the hinted delay (self-heals)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    expect(FakeWS.instances.length).toBe(1);
    // 4503 provisioning + retryAfterSec=5 → clamp ~5s（不走纯指数爆炸 / 不死等）。
    ws.close(4503, JSON.stringify({ retryAfterSec: 5, reason: "provisioning" }));
    // 提示延迟前不应重连。
    vi.advanceTimersByTime(4000);
    expect(FakeWS.instances.length).toBe(1);
    // 越过 5s+jitter(≤500ms) 后必然重连一次（创建新 ws 实例）。
    vi.advanceTimersByTime(2000);
    expect(FakeWS.instances.length).toBe(2);
  });
});

// ═══════════════ §7 auto-continue 确定性 idempotencyKey（dedup 对账）═══════════════
describe("ChatSocket auto-continue deterministic idempotencyKey (#3)", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("empty end_turn drives auto-continue with idem autocont-<sessId>-<targetMsgId>", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const userMsg = sock.sessions.get("s1")!.messages.find((m) => m.role === "user")!;
    // server 推空轮 end_turn final（无 answer 块）→ 应触发一次自动续写。
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [],
        meta: { stopReason: "end_turn" },
      }),
    });
    vi.advanceTimersByTime(10); // 跑 deferred setTimeout(0) 的 auto-continue
    const autocont = ws.sent
      .map((d) => JSON.parse(d))
      .find((p) => typeof p.idempotencyKey === "string" && p.idempotencyKey.startsWith("autocont-"));
    expect(autocont).toBeTruthy();
    expect(autocont.idempotencyKey).toBe(`autocont-s1-${userMsg.id}`);
    // 确定性：同 (sessId,targetMsgId) 再算一次必得同 key（跨 tab/replay 可被 server dedup）。
    expect(autocont.idempotencyKey).toBe(`autocont-s1-${userMsg.id}`);
  });

  test("short action promise end_turn does not start another paid turn", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({
      sessId: "s1",
      agentId: "main",
      text: "检查问题",
      model: "gpt-5.6-sol",
      effortLevel: "high",
    });
    const inboundCountBeforeFinal = ws.sent
      .map((data) => JSON.parse(data))
      .filter((payload) => payload.type === "inbound.message").length;
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [{ kind: "text", text: "好的，我现在检查并修复这个问题。" }],
        meta: { stopReason: "end_turn" },
      }),
    });
    vi.advanceTimersByTime(10);
    const sent = ws.sent.map((data) => JSON.parse(data));
    expect(sent.filter((payload) => payload.type === "inbound.message")).toHaveLength(inboundCountBeforeFinal);
    expect(sent.some((payload) =>
      String(payload.idempotencyKey ?? "").startsWith("autocont-preamble-"))).toBe(false);
    const session = sock.sessions.get("s1")!;
    expect(session.messages.some((message) =>
      message.role === "user" && message.text === "↻ 自动继续执行")).toBe(false);
    expect(session.messages.some((message) =>
      message.role === "assistant" && message.text === "好的，我现在检查并修复这个问题。")).toBe(true);
    expect(session._sendingInFlight).toBe(false);
  });

  test("合成续写复用被中断 turn 的路由字段(model/teamMode)——缺失会被 codex 计费闸拒", () => {
    // 2026-07-07 事故:服务重启自动续写不带 model/teamMode → 桥不做 codex 改写
    // (无 server requestId)→ 暖 codex 会话续写被 CODEX_BILLING_GUARD fail-closed。
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi", model: "gpt-5.6-sol", teamMode: true, effortLevel: "high" });
    // 空轮 end_turn → 自动续写
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [],
        meta: { stopReason: "end_turn" },
      }),
    });
    vi.advanceTimersByTime(10);
    const autocont = ws.sent
      .map((d) => JSON.parse(d))
      .find((p) => typeof p.idempotencyKey === "string" && p.idempotencyKey.startsWith("autocont-"));
    expect(autocont).toBeTruthy();
    expect(autocont.model).toBe("gpt-5.6-sol");
    expect(autocont.teamMode).toBe(true);
    expect(autocont.effortLevel).toBe("high");
  });

  test("服务重启 exact tape 自动恢复同样复用路由字段", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "跑团队任务", model: "gpt-5.6-sol", teamMode: true });
    // 模型尚未吐出首帧时恰逢部署：service_restart 必须释放旧 dispatch slot，
    // exact sync 带回安全终态后才能把恢复子轮真正发出去。
    ws.onmessage?.({
      data: JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:s1",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        frameSeq: 1,
        isFinal: true,
        ts: 9e12,
        blocks: [],
        meta: { interrupted: "service_restart" },
      }),
    });
    const session = sock.sessions.get("s1")!;
    const source = session.messages.find((message) => message.role === "user")!;
    source._source = "server";
    session.messages.push({
      id: "restart-terminal",
      role: "assistant",
      text: "",
      ts: 9e12 + 2,
      _source: "server",
      _turnTapeId: "tape-restart",
      _clientMessageId: source.id,
      _errorCode: "service_restart",
    });
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    await Promise.resolve();
    const cont = ws.sent
      .map((d) => JSON.parse(d))
      .find((p) => typeof p.idempotencyKey === "string" && p.idempotencyKey.startsWith("recover-turn-"));
    expect(cont).toBeTruthy();
    expect(cont.model).toBe("gpt-5.6-sol");
    expect(cont.teamMode).toBe(true);
    expect(cont.content.recovery).toMatchObject({
      sourceClientMessageId: source.id,
      rootClientMessageId: source.id,
      attempt: 1,
      max: 10,
      automatic: true,
    });
  });
});

describe("resume_failed 游标仲裁(容器=唯一裁决者)", () => {
  // 语义修订(2026-07-11 boss 生产事故 webmrfo3rtrwhgi15):旧断言「to=0 一律视为陈旧信号、
  // 游标不动」被生产证伪 —— 容器回收重建后 outboundRing 从零计数,hello 仲裁答复
  // resume_failed{from:14,to:0,no_buffer} 是**容器本人**对自家空 ring 的权威裁决;游标不归零
  // 则新生代帧 seq=1..14 全被 acceptFrameSeq 黑洞:imageEdit 免模型直投轮只有一帧终帧,
  // 整轮蒸发(占位卡永转/结果只能靠 REST 对账迟到)。当年「只进不退」防的是 bridge 越权伪造
  // resume_failed,该源已根治(bridge 对自身 miss 刻意不发,replay 唯一裁决者=容器);
  // 空 ring 无帧可重放,归零零重复应用面。非重启签名(to>0)仍保持只进不退。
  test("重启签名(no_buffer,to=0) → 游标归零(冷容器新生代帧不被黑洞)", () => {
    const s = sess();
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 42, reason: "buffer_miss" } as never, {});
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 42, to: 0, reason: "no_buffer" } as never, {});
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(0);
  });
  test("非重启签名(to>0)仍只进不退(buffer_miss 带倒退 to 不回退游标)", () => {
    const s = sess();
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 42, reason: "buffer_miss" } as never, {});
    applyResumeFailed(s, { type: "outbound.resume_failed", sessionKey: "agent:main:webchat:dm:s1", channel: "webchat", peer: { id: "s1", kind: "dm" }, from: 0, to: 7, reason: "buffer_miss" } as never, {});
    expect(s._lastFrameSeqByKey?.["agent:main:webchat:dm:s1"]).toBe(42);
  });
});

// ═══════════════ 归档 / 上下文重建文案（SESSION_ARCHIVE_DESIGN §5）═══════════════
describe("归档 / 上下文重建文案（§5 统一权威）", () => {
  test("contextRebuiltNotice：注入条数占位 + 合同原文", () => {
    expect(contextRebuiltNotice(40)).toBe(
      "已重新加载会话上下文(最近 40 条对话摘要)。更早的细节助手可能记不全,如需引用旧内容可直接粘贴。",
    );
  });
  test("loadOlderHistoryLabel：剩余条数占位 + 合同原文", () => {
    expect(loadOlderHistoryLabel(120)).toBe("从云端加载更早的历史(还有 120 条)");
  });
});

// ═══════════════ sys.context_rebuilt 帧 → system 提示行（§3.3）═══════════════
describe("sys.context_rebuilt 帧处理", () => {
  afterEach(() => {
    FakeWS.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function openWithTurn() {
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const sock = makeSocket();
    sock.setGateReady(true);
    const ws = FakeWS.instances.at(-1)!;
    ws.open();
    sock.sendMessage({ sessId: "s1", agentId: "main", text: "hi" });
    const clientMessageId = sock.sessions.get("s1")!._activeClientMessageId!;
    ws.onmessage?.({ data: JSON.stringify({
      type: "outbound.ack",
      admitted: true,
      peer: { id: "s1", kind: "dm" },
      clientMessageId,
    }) });
    return { sock, ws };
  }

  test("插入一条 client-owned system 提示行(§5 文案) + 会话 transient 软提示", () => {
    const { sock, ws } = openWithTurn();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "sys.context_rebuilt",
        channel: "webchat",
        peer: { id: "s1", kind: "dm" },
        agentId: "main",
        messageCount: 40,
        frameSeq: 5,
        ts: 9e12,
      }),
    });
    const s = sock.sessions.get("s1")!;
    const sysRows = s.messages.filter((m) => m.role === "system");
    expect(sysRows).toHaveLength(1);
    expect(sysRows[0].text).toBe(contextRebuiltNotice(40));
    expect(isServerAuthoredRow(sysRows[0])).toBe(false); // client-owned
    // 同文案的会话级 transient 软提示(live flash)。
    expect(sock.getTransientNotice("s1")?.text).toBe(contextRebuiltNotice(40));
    sock.stop();
  });

  test("幂等：同帧(同 frameSeq)重复到达只插一条", () => {
    const { sock, ws } = openWithTurn();
    const frame = JSON.stringify({
      type: "sys.context_rebuilt",
      channel: "webchat",
      peer: { id: "s1", kind: "dm" },
      messageCount: 40,
      frameSeq: 5,
      ts: 9e12,
    });
    ws.onmessage?.({ data: frame });
    ws.onmessage?.({ data: frame }); // reconnect replay
    const s = sock.sessions.get("s1")!;
    expect(s.messages.filter((m) => m.role === "system")).toHaveLength(1);
    sock.stop();
  });

  test("system 提示行经 full 对账合并不被抹掉(server 从不产出 system 行)", () => {
    const { sock, ws } = openWithTurn();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "sys.context_rebuilt",
        peer: { id: "s1", kind: "dm" },
        messageCount: 12,
        frameSeq: 3,
        ts: 9e12,
      }),
    });
    const s = sock.sessions.get("s1")!;
    const sysId = s.messages.find((m) => m.role === "system")!.id;
    // 随后 server full 对账(只带回 server-authored 助手行,绝不含 system 行)。
    const srv = (id: string, seq: number): ChatMessage =>
      ({ id, role: "assistant", text: "答", ts: seq, _source: "server", _seq: seq }) as ChatMessage;
    sock.applyServerMessages("s1", "main", [srv("srv1", 1)], true, 1);
    expect(sock.sessions.get("s1")!.messages.some((m) => m.id === sysId)).toBe(true); // 未被丢弃
    sock.stop();
  });
});

// ═══════════════ 同步权威传播:过期载荷整体拒绝(版本护栏)═══════════════
describe("applyServerMessages 版本护栏", () => {
  const srvRow = (id: string, seq: number, updTs: number): ChatMessage =>
    ({ id, role: "assistant", text: `v${updTs}`, ts: updTs, _source: "server", _seq: seq, _orderSeq: seq }) as ChatMessage;

  test("被证明过期的载荷(updatedAt<水位)整体丢弃:不覆盖消息、不回退归档计数、水位不动", () => {
    const sock = makeSocket();
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 2, 200)], true, 2, {
      archivedThroughSeq: 0, archivedCount: 7, serverUpdatedAt: 200,
    });
    const before = sock.sessions.get("s1")!;
    expect(before.messages.find((m) => m.id === "srv-a")!.text).toBe("v200");
    // 旧 full 晚到:同 id 旧内容 + 回退的归档计数 → 必须整体无副作用
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 1, 100)], true, 1, {
      archivedThroughSeq: 0, archivedCount: 3, serverUpdatedAt: 100,
    });
    const s = sock.sessions.get("s1")!;
    expect(s.messages.find((m) => m.id === "srv-a")!.text).toBe("v200");
    expect(s._archivedCount).toBe(7);
    expect(s._lastServerSyncUpdatedAt).toBe(200);
    sock.stop();
  });

  test("免单事务推进版本后，晚到的免单前 full 被整体拒绝", () => {
    const sock = makeSocket();
    const applied = {
      ...srvRow("srv-waived", 2, 201),
      usage: { costCredits: "259", waived: true },
    };
    sock.applyServerMessages("s1", "main", [applied], true, 2, { serverUpdatedAt: 201 });
    sock.applyServerMessages(
      "s1",
      "main",
      [{ ...srvRow("srv-waived", 2, 200), usage: { costCredits: "259" } }],
      true,
      2,
      { serverUpdatedAt: 200 },
    );
    const message = sock.sessions.get("s1")!.messages.find((m) => m.id === "srv-waived")!;
    expect(message.text).toBe("v201");
    expect(message.usage?.waived).toBe(true);
    sock.stop();
  });

  test("live 免单先到时，同版本旧 full 可更新其他字段但不能撤销 waived", () => {
    const sock = makeSocket();
    const turnKey = "d".repeat(64);
    sock.applyServerMessages(
      "s1",
      "main",
      [{ ...srvRow("srv-waived", 2, 200), _turnKey: turnKey, usage: { costCredits: "259" } }],
      true,
      2,
      { serverUpdatedAt: 200 },
    );
    const session = sock.sessions.get("s1")!;
    applyCostWaived(session, {
      type: "outbound.cost_waived",
      sessionId: "s1",
      turnKey,
      refundedCredits: "259",
    });
    sock.applyServerMessages(
      "s1",
      "main",
      [{ ...srvRow("srv-waived", 2, 199), _turnKey: turnKey, usage: { costCredits: "300" } }],
      true,
      2,
      { serverUpdatedAt: 200 },
    );
    const message = session.messages.find((m) => m.id === "srv-waived")!;
    expect(message.text).toBe("v199");
    expect(message.usage).toEqual({ costCredits: "300", waived: true });
    sock.stop();
  });

  test("等于/高于水位的载荷正常应用,水位随 full 与增量共同推进", () => {
    const sock = makeSocket();
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 2, 200)], true, 2, { serverUpdatedAt: 200 });
    // 增量推进水位到 300
    sock.applyServerMessages("s1", "main", [srvRow("srv-b", 3, 300)], false, 3, { serverUpdatedAt: 300 });
    expect(sock.sessions.get("s1")!._lastServerSyncUpdatedAt).toBe(300);
    // 250 的旧 full(介于两者)被拒:srv-b 不被"缺席删除"
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 2, 200)], true, 2, { serverUpdatedAt: 250 });
    expect(sock.sessions.get("s1")!.messages.some((m) => m.id === "srv-b")).toBe(true);
    // 350 的 fresh full 不含 srv-b → 版本护栏通过,缺席删除传播生效
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 2, 340)], true, 2, { serverUpdatedAt: 350 });
    expect(sock.sessions.get("s1")!.messages.some((m) => m.id === "srv-b")).toBe(false);
    sock.stop();
  });

  test("无版本信息的载荷照常合并但不授出缺席删除", () => {
    const sock = makeSocket();
    sock.applyServerMessages("s1", "main", [srvRow("srv-a", 2, 200)], true, 2, { serverUpdatedAt: 200 });
    sock.applyServerMessages("s1", "main", [srvRow("srv-c", 4, 400)], true, 4);
    const s = sock.sessions.get("s1")!;
    expect(s.messages.some((m) => m.id === "srv-c")).toBe(true);
    expect(s.messages.some((m) => m.id === "srv-a")).toBe(true); // 缺席但无授权 → 保留
    sock.stop();
  });
});
