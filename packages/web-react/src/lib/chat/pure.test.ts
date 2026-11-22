import { describe, expect, test } from "vitest";
import {
  computeTypingLabel,
  deriveConnBanner,
  isPermanentJournalError,
  summarizeSystemCallbackUserTurn,
} from "./pure";

// INC-20261028-STALE-ENGINE-STARTING: commercial uid 4 saw 「正在启动引擎 (1184s)」 after
// the phone was backgrounded for 19 minutes; the engine had been ready since 19s.
describe("computeTypingLabel — calm human copy without engine/anxiety jargon", () => {
  const base = { name: "全能助手", turnStatus: "engine_starting" as const };

  test("startup frames still flowing (silence 5s) → 正在准备中（不暴露启动引擎）", () => {
    const { text } = computeTypingLabel({ ...base, secs: 8, silenceMs: 5_000 });
    expect(text).toContain("正在准备中");
    expect(text).not.toContain("启动引擎");
  });

  test.each([31_000, 91_000, 1_184_000])("silence %ims → 温和提示且不显示启动引擎或无新数据", (silenceMs) => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs });
    expect(text).not.toContain("启动引擎");
    expect(text).not.toContain("无新数据");
    expect(text).toContain("思考中");
  });

  test("engine_resuming 同理", () => {
    const { text } = computeTypingLabel({ ...base, turnStatus: "engine_resuming", secs: 600, silenceMs: 500_000 });
    expect(text).not.toContain("恢复会话");
    expect(text).not.toContain("无新数据");
  });

  // Incident anchor (INC-20261028-STALE-ENGINE-STARTING): "transport down + stale → 连接已断开,计时按已发送分钟"
  // Atelier moved disconnect wording into ConnBanner; computeTypingLabel still reports elapsed minutes and never 启动引擎.
  test("transport down + stale → 不重复断线文案（由全局连接条承载），按已发送分钟展示后台处理中", () => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs: 1_163_000, transport: "connecting" });
    expect(text).toContain("正在后台处理中");
    expect(text).toContain("已发送 19 分钟");
    expect(text).not.toContain("连接已断开");
    expect(text).not.toContain("启动引擎");
  });

  test("transport down but frames fresh → 保持正在准备中", () => {
    const { text } = computeTypingLabel({ ...base, secs: 8, silenceMs: 2_000, transport: "connecting" });
    expect(text).toContain("正在准备中");
    expect(text).not.toContain("启动引擎");
  });

  test("hello detached snapshot → 正在后台处理中（不提示过程可能未同步）", () => {
    const { text } = computeTypingLabel({ ...base, secs: 1184, silenceMs: 0, detached: true });
    expect(text).toContain("正在后台处理中");
    expect(text).not.toContain("启动引擎");
    expect(text).not.toContain("过程可能未同步");
  });

  test("detached + status null 同样显示正在后台处理中", () => {
    const { text } = computeTypingLabel({ name: "全能助手", turnStatus: null, secs: 70, silenceMs: 0, detached: true });
    expect(text).toContain("正在后台处理中");
    expect(text).toContain("已发送 1 分钟");
    expect(text).not.toContain("过程可能未同步");
  });
});

describe("pure friendly copy helpers (P1-5 / P0-1)", () => {
  test("summarizeSystemCallbackUserTurn uses concise human titles without 系统回调/发布列车/Agent", () => {
    expect(summarizeSystemCallbackUserTurn({ id: "lsc-1", text: "终态: committed" })).toBe("发布已上线");
    expect(summarizeSystemCallbackUserTurn({ id: "lsc-2", text: "终态: failed" })).toBe("发布未通过，正在处理");
    expect(summarizeSystemCallbackUserTurn({ id: "lsc-3", text: "更新" })).toBe("发布状态已更新");
    expect(summarizeSystemCallbackUserTurn({ id: "dlgcb-1", text: "子任务已完成" })).toBe("后台任务已完成");
    expect(summarizeSystemCallbackUserTurn({ id: "cron-origin-1", text: "⏰" })).toBe("定时任务已触发");
    expect(summarizeSystemCallbackUserTurn({ id: "u-1", text: "[系统通知 · foo]" })).toBe("系统通知已送达");
  });

  test("deriveConnBanner translates internal renewal/recovery labels into plain Chinese", () => {
    expect(deriveConnBanner({ cls: "connecting", label: "会话续期中…", browserOnline: true, provisioning: false }))
      .toEqual({ tone: "info", text: "正在重新连接…" });
    expect(deriveConnBanner({ cls: "connecting", label: "正在恢复上一轮…", browserOnline: true, provisioning: false }))
      .toEqual({ tone: "info", text: "正在同步最新进展…" });
  });

  test("isPermanentJournalError identifies 4xx permanent statuses and ignores 5xx/timeouts", () => {
    expect(isPermanentJournalError({ status: 401 })).toBe(true);
    expect(isPermanentJournalError({ status: 403 })).toBe(true);
    expect(isPermanentJournalError({ status: 404 })).toBe(true);
    expect(isPermanentJournalError({ status: 503 })).toBe(false);
    expect(isPermanentJournalError(new Error("timeout"))).toBe(false);
  });
});
