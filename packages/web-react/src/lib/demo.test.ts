// t-839 杂项 P3 · ?demo=1 fixture 自洽性(D-01 ~ D-03)。
import { describe, expect, it } from "vitest";
import {
  DEMO_DEFAULT_MODEL_NAME,
  DEMO_MESSAGES,
  DEMO_MESSAGES_BY_SESSION,
  DEMO_MODELS,
  DEMO_SESSIONS,
  demoReply,
} from "./demo";

describe("demo fixtures", () => {
  it("D-01 演示回复提到的模型 = 默认选中的 DEMO_MODELS[0],不再写死别的名字", () => {
    expect(DEMO_DEFAULT_MODEL_NAME).toBe(DEMO_MODELS[0].display_name);
    expect(demoReply("你好")).toContain(`**${DEMO_MODELS[0].display_name}**`);
    expect(demoReply("你好", "某模型")).toContain("**某模型**");
    expect(demoReply("你好")).not.toContain("MiniMax-M3");
  });

  it("D-02 每个会话的 messageCount 与本地 fixture 条数一致(没有 fixture 的会话是空会话,标 0)", () => {
    for (const s of DEMO_SESSIONS) {
      expect(s.messageCount).toBe((DEMO_MESSAGES_BY_SESSION[s.id] ?? []).length);
    }
    expect(DEMO_MESSAGES_BY_SESSION.s1).toBe(DEMO_MESSAGES);
    expect(DEMO_MESSAGES.length).toBeGreaterThan(0);
  });

  it("D-03 会话带 createdAt 且不晚于 updatedAt(侧栏用时起点)", () => {
    for (const s of DEMO_SESSIONS) {
      expect(typeof s.createdAt).toBe("number");
      expect(s.createdAt as number).toBeLessThanOrEqual(Date.parse(s.updatedAt));
    }
  });

  it("demoReply 超长输入截断到 40 字并加省略号", () => {
    const long = "字".repeat(60);
    const out = demoReply(long);
    expect(out).toContain(`「${"字".repeat(40)}…」`);
  });
});
