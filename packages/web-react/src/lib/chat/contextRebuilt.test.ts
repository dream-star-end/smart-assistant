import { describe, expect, test } from "vitest";
import { contextRebuiltRow } from "./contextRebuilt";
import { addMessage, createSession } from "./model";
import { contextRebuiltNotice } from "./pure";

const base = { type: "sys.context_rebuilt" as const, peer: { id: "s1", kind: "dm" as const }, messageCount: 12 };

describe("sys.context_rebuilt 按 noticeId 去重", () => {
  test("同一段重建(同一 noticeId)重放、换了 frameSeq 也只提示一次", () => {
    const s = createSession({ id: "s1", agentId: "main" });
    const first = contextRebuiltRow(s, { ...base, noticeId: "u1:main", frameSeq: 7, reason: "engine-switch" });
    expect(first).not.toBeNull();
    addMessage(s, "system", first!.text, { id: first!.id, _source: "local" });
    expect(contextRebuiltRow(s, { ...base, noticeId: "u1:main", frameSeq: 7, reason: "engine-switch" })).toBeNull();
    expect(contextRebuiltRow(s, { ...base, noticeId: "u1:main", frameSeq: 9, reason: "engine-switch" })).toBeNull();
    // 下一段(另一回合)照常提示。
    expect(contextRebuiltRow(s, { ...base, noticeId: "u2:main", frameSeq: 12 })).not.toBeNull();
  });

  test("旧服务没有 noticeId:退回 frameSeq 去重", () => {
    const s = createSession({ id: "s1", agentId: "main" });
    const row = contextRebuiltRow(s, { ...base, frameSeq: 3 });
    expect(row?.id).toBe("sys-ctxrebuild-s1-f3");
    addMessage(s, "system", row!.text, { id: row!.id, _source: "local" });
    expect(contextRebuiltRow(s, { ...base, frameSeq: 3 })).toBeNull();
  });

  test("文案说清原因;旧帧不带原因时沿用原文案", () => {
    const s = createSession({ id: "s1", agentId: "main" });
    expect(contextRebuiltRow(s, { ...base, noticeId: "a", reason: "engine-switch" })?.text)
      .toBe("换了模型引擎，已用最近 12 条对话重建上下文。更早的细节助手可能记不全，如需引用旧内容可直接粘贴。");
    expect(contextRebuiltRow(s, { ...base, noticeId: "b", reason: "native-resume-loss" })?.text)
      .toContain("原会话没能直接续上");
    expect(contextRebuiltRow(s, { ...base, noticeId: "c" })?.text).toBe(contextRebuiltNotice(12));
  });
});
