import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { friendlyBridgeErrorMessage } from "./pure";
import {
  childSignature,
  defaultCollapsed,
  errorLabel,
  errorPresentation,
  isRedundantRuntimeEnvelope,
  isLive,
  messageKind,
  messageSignature,
  reviewVerdictBadge,
  safeMessageSignature,
  stripMarkdown,
} from "./render";

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role, text: "", ts: 1000, ...extra };
}
const CTX = { isLast: true, sending: false };

describe("messageKind 角色分派", () => {
  test("支持的 role 各自映射", () => {
    for (const r of [
      "user",
      "assistant",
      "thinking",
      "tool",
      "agent-group",
      "plan",
      "goal",
      "permission",
      "delegate-progress",
      "system",
    ] as const) {
      expect(messageKind({ role: r })).toBe(r);
    }
  });
  test("未知 role → unknown（不出卡）", () => {
    // @ts-expect-error 故意传未知 role 验证 fail-safe
    expect(messageKind({ role: "whatever" })).toBe("unknown");
  });
});

describe("底层 runtime 封包展示边界", () => {
  test("CCB bash_output_tail 只更新 Bash 工具卡，不独立渲染原始消息卡", () => {
    expect(isRedundantRuntimeEnvelope(mk("runtime-event", {
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-bash",
        tail: "真实后台输出",
        total_bytes: 18,
      },
    }))).toBe(true);
  });

  test("未投影的真实 runtime 事件仍可检查", () => {
    for (const event of [
      { type: "tool_progress", tool_use_id: "tool-1" },
      { type: "assistant_error", error: "exact failure" },
      { type: "future_runtime_event", exact: true },
    ]) {
      expect(isRedundantRuntimeEnvelope(mk("runtime-event", {
        _runtimeSource: "ccb",
        _runtimeEvent: event,
      }))).toBe(false);
    }
  });
});

describe("messageSignature 流式防闪签名", () => {
  test("内容不变 → 签名稳定（memo 跳过重渲）", () => {
    const m = mk("assistant", { text: "hello" });
    expect(messageSignature(m, CTX)).toBe(messageSignature(m, CTX));
  });

  test("plan steps:[null] does not throw; safeMessageSignature returns a string", () => {
    const m = mk("plan", { text: "计划", steps: [null] as unknown as ChatMessage["steps"] });
    expect(() => messageSignature(m, CTX)).not.toThrow();
    expect(safeMessageSignature(m, CTX)).toContain("plan");
  });

  test("assistant 文本增量 → 签名变化（触发重渲）", () => {
    const a = mk("assistant", { text: "hel" });
    const b = mk("assistant", { text: "hello" });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("等长替换也能探测（尾采样）", () => {
    const a = mk("assistant", { text: "abcdefghij" });
    const b = mk("assistant", { text: "abcdefghiZ" });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("isLast / sending 变化 → 签名变化（光标/动作条可见性）", () => {
    const m = mk("assistant", { text: "x" });
    expect(messageSignature(m, { isLast: true, sending: true })).not.toBe(
      messageSignature(m, { isLast: true, sending: false }),
    );
  });

  test("turnFinalAssistant 翻转 → 签名变化(轮末条评价行 sig-memo 关键:后续追加使原末条→非末条须重渲)", () => {
    const m = mk("assistant", { text: "答复" });
    expect(messageSignature(m, { isLast: false, sending: false, turnFinalAssistant: true })).not.toBe(
      messageSignature(m, { isLast: false, sending: false, turnFinalAssistant: false }),
    );
    // 缺省(undefined)与显式 false 等价 —— 老调用点不传该字段时行为不变。
    expect(messageSignature(m, { isLast: false, sending: false })).toBe(
      messageSignature(m, { isLast: false, sending: false, turnFinalAssistant: false }),
    );
  });

  test("tool 完成翻转 → 签名变化", () => {
    const a = mk("tool", { toolName: "Bash", _completed: false });
    const b = mk("tool", { toolName: "Bash", _completed: true, output: "done" });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("permission 解析翻转 → 签名变化", () => {
    const a = mk("permission", { requestId: "r1", _resolved: false });
    const b = mk("permission", { requestId: "r1", _resolved: true, _behavior: "allow" });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("permission _askUserExpiresAt 变化 → 签名变化", () => {
    const a = mk("permission", { requestId: "r1", _resolved: false });
    const b = mk("permission", { requestId: "r1", _resolved: false, _askUserExpiresAt: 1 });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("agent-group 子块内容变化经 childSignature 传导到父签名", () => {
    const base = (out: string): ChatMessage =>
      mk("agent-group", {
        text: "子任务",
        childBlocks: [{ kind: "tool_use", blockId: "b1", toolName: "Bash", output: out, _completed: true }],
      });
    expect(messageSignature(base(""), CTX)).not.toBe(messageSignature(base("output-arrived"), CTX));
  });

  test("agent-group origin/fallback 变化 → 签名变化（TeamPanel 名称更新）", () => {
    const a = mk("agent-group", { text: "子任务" });
    const b = mk("agent-group", {
      text: "子任务",
      _agentGroupOrigin: "codex-collab",
      _teamFallback: true,
    });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("usage.traceId / costCredits 到达 → assistant 签名变化（meta 行）", () => {
    const a = mk("assistant", { text: "x" });
    const b = mk("assistant", { text: "x", usage: { traceId: "t1", costCredits: "120" } });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });

  test("agent-group 审查裁决到达 → 签名变化（PASS/未通过徽记后到时重渲）", () => {
    const a = mk("agent-group", { text: "审查", _delegateAgentId: "hidden-reviewer", _completed: true });
    const b = mk("agent-group", {
      text: "审查",
      _delegateAgentId: "hidden-reviewer",
      _completed: true,
      _reviewVerdict: "PASS",
    });
    const c = mk("agent-group", {
      text: "审查",
      _delegateAgentId: "hidden-reviewer",
      _completed: true,
      _reviewVerdict: "NEEDS_FIX",
    });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
    expect(messageSignature(b, CTX)).not.toBe(messageSignature(c, CTX));
  });
});

describe("reviewVerdictBadge 审查裁决徽记（单一权威纯函数）", () => {
  test("审查员行 PASS → success 通过徽记", () => {
    expect(
      reviewVerdictBadge({ _delegateAgentId: "hidden-reviewer", _reviewVerdict: "PASS" }),
    ).toEqual({ label: "PASS", tone: "success" });
  });

  test("审查员行 NEEDS_FIX → warning「未通过」徽记（不用 danger 以免与执行失败混淆）", () => {
    expect(
      reviewVerdictBadge({ _delegateAgentId: "hidden-reviewer", _reviewVerdict: "NEEDS_FIX" }),
    ).toEqual({ label: "未通过", tone: "warning" });
  });

  test("审查员行无裁决（审查未产出/降级）→ null（执行态徽记照常）", () => {
    expect(reviewVerdictBadge({ _delegateAgentId: "hidden-reviewer" })).toBeNull();
  });

  test("普通成员行即使误带 verdict → null（裁决仅审查员行渲染）", () => {
    expect(
      reviewVerdictBadge({ _delegateAgentId: "coding-assistant", _reviewVerdict: "PASS" }),
    ).toBeNull();
    expect(reviewVerdictBadge({ _reviewVerdict: "NEEDS_FIX" })).toBeNull();
  });

  test("未知裁决值 → null（fail-safe，不渲染裁决徽记）", () => {
    expect(
      reviewVerdictBadge({ _delegateAgentId: "hidden-reviewer", _reviewVerdict: "WAT" as never }),
    ).toBeNull();
  });

  test("裁决与执行态正交：status=ok 的审查照样可裁决 NEEDS_FIX", () => {
    // 一次成功执行(_delegateStatus 'ok')的审查行仍可裁 NEEDS_FIX；徽记只读 _reviewVerdict。
    expect(
      reviewVerdictBadge({ _delegateAgentId: "hidden-reviewer", _reviewVerdict: "NEEDS_FIX" }),
    ).toEqual({ label: "未通过", tone: "warning" });
  });
});

describe("childSignature", () => {
  test("子块 output / 完成态变化 → 签名变化", () => {
    const a = childSignature({ kind: "tool_use", blockId: "b", toolName: "X", _completed: false });
    const b = childSignature({ kind: "tool_use", blockId: "b", toolName: "X", _completed: true, output: "y" });
    expect(a).not.toBe(b);
  });
  test("bashTail totalBytes 增长 → 签名变化", () => {
    const a = childSignature({ kind: "tool_use", blockId: "b", bashTail: { tail: "a", totalBytes: 10, truncatedHead: false } });
    const b = childSignature({ kind: "tool_use", blockId: "b", bashTail: { tail: "ab", totalBytes: 20, truncatedHead: false } });
    expect(a).not.toBe(b);
  });
  test("bashTail 相同字节数但正文/截断态变化 → 签名变化", () => {
    const a = childSignature({ kind: "tool_use", blockId: "b", bashTail: { tail: "旧", totalBytes: 20, truncatedHead: false } });
    const b = childSignature({ kind: "tool_use", blockId: "b", bashTail: { tail: "新", totalBytes: 20, truncatedHead: true } });
    expect(a).not.toBe(b);
  });
});

describe("历史 Bash tail 展示签名", () => {
  test("顶层工具相同 totalBytes 的后序快照仍触发重渲", () => {
    const before = mk("tool", {
      toolName: "Bash",
      bashTail: { tail: "旧快照", totalBytes: 42, truncatedHead: false },
    });
    const after = {
      ...before,
      bashTail: { tail: "新快照", totalBytes: 42, truncatedHead: true },
    };
    expect(messageSignature(before, CTX)).not.toBe(messageSignature(after, CTX));
  });

  test("exact agent-group 的 presentation revision 穿透 tape SHA 快捷签名", () => {
    const before = mk("agent-group", {
      _turnTapeComplete: true,
      _turnTapeSha256: "a".repeat(64),
      _runtimeBashTailRevision: 1,
      childBlocks: [{ kind: "tool_use", blockId: "child", toolName: "Bash" }],
    });
    const after = { ...before, _runtimeBashTailRevision: 2 };
    expect(messageSignature(before, CTX)).not.toBe(messageSignature(after, CTX));
  });
});

describe("isLive / defaultCollapsed 折叠态默认", () => {
  test("thinking：末条 + 本轮进行中 = live（展开）；否则完成折叠", () => {
    const t = mk("thinking", { text: "..." });
    expect(isLive(t, { isLast: true, sending: true })).toBe(true);
    expect(defaultCollapsed(t, { isLast: true, sending: true })).toBe(false);
    expect(defaultCollapsed(t, { isLast: false, sending: true })).toBe(true);
    expect(defaultCollapsed(t, { isLast: true, sending: false })).toBe(true);
  });

  test("agent-group：运行展开、完成折叠（与末位无关）", () => {
    const running = mk("agent-group", { _completed: false });
    const done = mk("agent-group", { _completed: true });
    expect(defaultCollapsed(running, { isLast: false, sending: false })).toBe(false);
    expect(defaultCollapsed(done, { isLast: true, sending: true })).toBe(true);
  });
});

describe("errorLabel / stripMarkdown", () => {
  test("已知错误码 → 中文，未知 → 友好兜底(不再抛裸码)", () => {
    expect(errorLabel("insufficient_credits")).toBe("积分余额不足");
    expect(errorLabel("conn_kicked")).toBe("连接已断开");
    expect(errorLabel("some_new_code")).toBe("出错了"); // 未知码不再回退裸码,统一友好
    expect(errorLabel(undefined)).toBe("出错了");
  });
  test("模型权威拒帧的标题(类别)—— 不再回退「出错了」", () => {
    expect(errorLabel("model_config_changed_retry_turn")).toBe("模型配置已更新，请重发");
    expect(errorLabel("model_not_available")).toBe("模型不可用");
    expect(errorLabel("unresolved_agent_model")).toBe("未能确定模型");
    expect(errorLabel("model_authority_unavailable")).toBe("模型服务暂时不可用");
    expect(errorLabel("model_catalog_unavailable")).toBe("模型服务暂时不可用");
  });
  test("存量 MODEL_AUTHORITY_INVALID 会脱敏，但无账务证据时不谎报免单/站内信", () => {
    const raw = '{"error":{"code":"MODEL_AUTHORITY_INVALID","status":403,"message":"forbidden"},"request_id":"9cad8ad4bf74b7050694873e6ab16b01"}';
    const presented = errorPresentation("ENGINE_ERROR", raw, raw);
    expect(presented).toEqual({
      title: "任务未正常完成",
      message: "长任务的执行凭证未能继续。你的消息已保留，可以重新尝试。",
      detail: "请求 ID：9cad8ad4bf74b7050694873e6ab16b01",
      waived: false,
    });
    expect(JSON.stringify(presented)).not.toMatch(/MODEL_AUTHORITY_INVALID|forbidden|403/);
    expect(JSON.stringify(presented)).not.toMatch(/免单|退回|站内信/);
  });
  test("仅 applied waiver + receipt 的持久证据显示免单完成态", () => {
    const raw = '{"error":{"code":"MODEL_AUTHORITY_INVALID","status":403,"message":"forbidden"}}';
    const presented = errorPresentation("ENGINE_ERROR", raw, raw, true);
    expect(presented.title).toBe("本轮已自动免单");
    expect(presented.message).toContain("已发送站内信说明");
    expect(presented.waived).toBe(true);
  });
  test("ENGINE_ERROR 不把 JSON/英文堆栈作为正文或详情展示", () => {
    const raw = '{"error":"API Error","code":"UPSTREAM"}\n at run (/srv/app.js:1:2)';
    const presented = errorPresentation("ENGINE_ERROR", raw, raw);
    expect(presented.title).toBe("任务执行失败");
    expect(presented.message).toContain("内部错误");
    expect(presented.detail).toBeUndefined();
    expect(JSON.stringify(presented)).not.toContain("API Error");
  });
  test("stripMarkdown 去标记取纯文本", () => {
    expect(stripMarkdown("# 标题")).toBe("标题");
    expect(stripMarkdown("**粗** 和 `代码`")).toBe("粗 和 代码");
    expect(stripMarkdown("[链接](http://x)")).toBe("链接");
    expect(stripMarkdown("- 项目")).toBe("项目");
  });
});

describe("errorPresentation 兜底分支:不再裸透传 text(任务②)", () => {
  test("裸 [turn failed 终止器 → 按码文案作正文,原文进 detail(可见排查线索)", () => {
    const p = errorPresentation("upstream_failed", "[turn failed: model overloaded]", undefined);
    expect(p.title).toBe("模型服务暂时中断");
    expect(p.message).toBe(friendlyBridgeErrorMessage("upstream_failed"));
    expect(p.message).not.toContain("turn failed");
    expect(p.detail).toBe("[turn failed: model overloaded]");
    expect(p.waived).toBe(false);
  });

  test("[error] 终止器 → 同样收敛为按码文案 + 原文进 detail", () => {
    const p = errorPresentation("upstream_failed", "[error] server shutting down", undefined);
    expect(p.message).toBe(friendlyBridgeErrorMessage("upstream_failed"));
    expect(p.detail).toBe("[error] server shutting down");
  });

  test("已知友好文案(applyOutboundError 写入的按码正文)原样保留", () => {
    const friendly = friendlyBridgeErrorMessage("upstream_failed");
    const p = errorPresentation("upstream_failed", friendly, undefined);
    expect(p.message).toBe(friendly);
  });

  test("JSON 信封原文不进 detail(隐去技术串),仍按码文案", () => {
    const p = errorPresentation("internal_error", '{"error":"boom","status":500}', undefined);
    expect(p.message).toBe(friendlyBridgeErrorMessage("internal_error"));
    expect(p.detail).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("boom");
  });

  test("container_outdated 合法服务端 message → 透传作正文(白名单)", () => {
    const p = errorPresentation("container_outdated", "运行环境已升级，请刷新页面。", undefined);
    expect(p.title).toBe("运行环境已更新，请刷新页面");
    expect(p.message).toBe("运行环境已升级，请刷新页面。");
  });

  test("未知码 + 合法正文 → 标题「出错了」+ 通用兜底正文,正文进 bodyText(R6:不再降进 detail)", () => {
    const p = errorPresentation("brand_new_code", "临时不可用", undefined);
    expect(p.title).toBe("出错了");
    expect(p.message).toBe("系统暂时不可用，请稍后重试。");
    // R6:合法部分回答(非终止器/非内部串)现走 bodyText 正常渲染,不再被降进「查看详情」。
    expect(p.bodyText).toBe("临时不可用");
    expect(p.detail).toBeUndefined();
  });
});

describe("errorPresentation R6/R7:失败轮部分正文 + detail 守卫", () => {
  test("R6:合法部分回答 + 尾部终止器同串 → 部分回答进 bodyText,红卡正文按码,终止器进 detail", () => {
    const raw = "这是模型已经写出的一段正常回答。\n\n[turn failed: Selected model is at capacity. Please try a different model.]\n";
    const p = errorPresentation("engine_error", raw, undefined);
    expect(p.title).not.toBe("出错了");
    expect(p.bodyText).toBe("这是模型已经写出的一段正常回答。");
    expect(p.message).toBe(friendlyBridgeErrorMessage("engine_error"));
    expect(p.message).not.toContain("turn failed");
    expect(p.detail).toBe("[turn failed: Selected model is at capacity. Please try a different model.]");
    // 终止器是纯 prose,detail/bodyText 均无 JSON 信封形态。
    expect(p.detail).not.toMatch(/"error"|"status"/);
    expect(p.bodyText).not.toMatch(/[{[]/);
  });

  test("R6:纯终止器(无部分回答)→ 无 bodyText,红卡按码 + 终止器进 detail(回归)", () => {
    const p = errorPresentation("upstream_failed", "[turn failed: model overloaded]", undefined);
    expect(p.bodyText).toBeUndefined();
    expect(p.message).toBe(friendlyBridgeErrorMessage("upstream_failed"));
    expect(p.detail).toBe("[turn failed: model overloaded]");
  });

  test("R7:非 engine_error(model_capacity)带 Codex JSON errorDetail → 脱敏保留请求 ID,不泄漏 JSON", () => {
    const jsonDetail = '{"error":{"code":"model_capacity","status":503},"request_id":"9cad8ad4bf74b7050694873e6ab16b01"}';
    const p = errorPresentation("model_capacity", "", jsonDetail);
    expect(p.message).toBe(friendlyBridgeErrorMessage("model_capacity"));
    expect(p.detail).toBe("请求 ID：9cad8ad4bf74b7050694873e6ab16b01");
    expect(JSON.stringify(p)).not.toMatch(/model_capacity","status|503|"error":\{/);
  });

  test("R7:内部 JSON detail 无可提取请求 ID → detail 整个隐去(不外泄)", () => {
    const p = errorPresentation("model_capacity", "", '{"error":"overloaded upstream at run (/srv/x.js:1:2)"}');
    expect(p.detail).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("overloaded upstream");
  });

  test("R6:合法部分回答 + 内部 JSON detail(model_capacity)→ 部分回答仍可见,detail 脱敏", () => {
    const p = errorPresentation(
      "model_capacity",
      "部分结果:第一步已完成。",
      '{"error":{"status":503},"request_id":"abcd1234abcd1234abcd1234abcd1234"}',
    );
    expect(p.bodyText).toBe("部分结果:第一步已完成。");
    expect(p.message).toBe(friendlyBridgeErrorMessage("model_capacity"));
    expect(p.detail).toBe("请求 ID：abcd1234abcd1234abcd1234abcd1234");
    expect(JSON.stringify(p)).not.toMatch(/"error":\{|503/);
  });

  test("R6:engine_error 且正文本身是内部串 → 仍收敛为内部错误文案(不当部分回答)", () => {
    const raw = '{"error":"API Error","code":"UPSTREAM"}\n at run (/srv/app.js:1:2)';
    const p = errorPresentation("engine_error", raw, undefined);
    expect(p.bodyText).toBeUndefined();
    expect(p.message).toContain("内部错误");
    expect(JSON.stringify(p)).not.toContain("API Error");
  });
});
