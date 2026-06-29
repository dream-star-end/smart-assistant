import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import {
  childSignature,
  defaultCollapsed,
  errorLabel,
  isLive,
  messageKind,
  messageSignature,
  stripMarkdown,
} from "./render";

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role, text: "", ts: 1000, ...extra };
}
const CTX = { isLast: true, sending: false };

describe("messageKind 角色分派", () => {
  test("九类 role 各自映射", () => {
    for (const r of [
      "user",
      "assistant",
      "thinking",
      "tool",
      "agent-group",
      "plan",
      "permission",
      "delegate-progress",
      "research-report",
      "system",
    ] as const) {
      expect(messageKind({ role: r })).toBe(r);
    }
  });
  test("goal（codex 专属，v5 不实现）与未知 role → unknown（不出卡）", () => {
    expect(messageKind({ role: "goal" })).toBe("unknown");
    // @ts-expect-error 故意传未知 role 验证 fail-safe
    expect(messageKind({ role: "whatever" })).toBe("unknown");
  });
});

describe("messageSignature 流式防闪签名", () => {
  test("内容不变 → 签名稳定（memo 跳过重渲）", () => {
    const m = mk("assistant", { text: "hello" });
    expect(messageSignature(m, CTX)).toBe(messageSignature(m, CTX));
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

  test("agent-group 子块内容变化经 childSignature 传导到父签名", () => {
    const base = (out: string): ChatMessage =>
      mk("agent-group", {
        text: "子任务",
        childBlocks: [{ kind: "tool_use", blockId: "b1", toolName: "Bash", output: out, _completed: true }],
      });
    expect(messageSignature(base(""), CTX)).not.toBe(messageSignature(base("output-arrived"), CTX));
  });

  test("usage.traceId / costCredits 到达 → assistant 签名变化（meta 行）", () => {
    const a = mk("assistant", { text: "x" });
    const b = mk("assistant", { text: "x", usage: { traceId: "t1", costCredits: "120" } });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });
});

describe("research-report 签名", () => {
  const baseManifest = {
    sources: [],
    quotes: [],
    claims: [],
    coverage: { verifiedClaims: 1, totalClaims: 2 },
    gates: {
      quoteFirst: { passed: true, checked: 0, failed: 0 },
      claimBound: { passed: true, checked: 0, failed: 0 },
      identifier: { passed: true, checked: 0, failed: 0 },
      retraction: { passed: true, checked: 0, failed: 0 },
    },
  };
  test("coverage 变化 → 签名变化(就地 mutate 防漏渲)", () => {
    const a = mk("research-report", { _researchManifest: { ...baseManifest } });
    const b = mk("research-report", {
      _researchManifest: { ...baseManifest, coverage: { verifiedClaims: 2, totalClaims: 2 } },
    });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
  });
  test("文献库条数变化 → 签名变化", () => {
    const a = mk("research-report", { _researchLibrary: [] });
    const b = mk("research-report", { _researchLibrary: [{ id: "s1", title: "T", authors: [] }] });
    expect(messageSignature(a, CTX)).not.toBe(messageSignature(b, CTX));
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
  test("stripMarkdown 去标记取纯文本", () => {
    expect(stripMarkdown("# 标题")).toBe("标题");
    expect(stripMarkdown("**粗** 和 `代码`")).toBe("粗 和 代码");
    expect(stripMarkdown("[链接](http://x)")).toBe("链接");
    expect(stripMarkdown("- 项目")).toBe("项目");
  });
});
