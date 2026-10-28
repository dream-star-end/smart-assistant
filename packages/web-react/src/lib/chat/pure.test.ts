import { describe, expect, test } from "vitest";
import { computeTypingLabel } from "./pure";

// INC-20261028-STALE-ENGINE-STARTING: commercial uid 4 saw 「正在启动引擎 (1184s)」 after
// the phone was backgrounded for 19 minutes; the engine had been ready since 19s.
describe("computeTypingLabel — engine startup must not outlive the frame stream", () => {
  const base = { name: "全能助手", turnStatus: "engine_starting" as const };

  test("startup frames still flowing (silence 5s) → 正在启动引擎", () => {
    expect(computeTypingLabel({ ...base, secs: 8, silenceMs: 5_000 }).text).toContain("正在启动引擎");
  });

  test.each([31_000, 91_000, 1_184_000])("silence %ims → 不再显示启动引擎", (silenceMs) => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs });
    expect(text).not.toContain("启动引擎");
    expect(text).toContain("无新数据");
  });

  test("engine_resuming 同理", () => {
    const { text } = computeTypingLabel({ ...base, turnStatus: "engine_resuming", secs: 600, silenceMs: 500_000 });
    expect(text).not.toContain("恢复会话");
  });

  test("transport down + stale → 连接已断开,计时按已发送分钟", () => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs: 1_163_000, transport: "connecting" });
    expect(text).toContain("连接已断开，正在重连");
    expect(text).toContain("回合可能仍在后台运行");
    expect(text).toContain("已发送 19 分钟");
    expect(text).not.toContain("启动引擎");
  });

  test("transport down but frames fresh → 不抢启动态(断线瞬间不误报)", () => {
    expect(computeTypingLabel({ ...base, secs: 8, silenceMs: 2_000, transport: "connecting" }).text)
      .toContain("正在启动引擎");
  });

  test("hello detached snapshot → 后台运行中,不显示启动引擎", () => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs: 0, detached: true });
    expect(text).toContain("后台运行中");
    expect(text).not.toContain("启动引擎");
  });

  test("detached + status null(引擎已就绪)同样显示后台运行中", () => {
    const { text } = computeTypingLabel({ name: "全能助手", turnStatus: null, secs: 70, silenceMs: 0, detached: true });
    expect(text).toContain("后台运行中");
    expect(text).toContain("已发送 1 分钟");
  });
});
