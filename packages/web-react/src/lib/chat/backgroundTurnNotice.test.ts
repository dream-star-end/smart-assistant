import { describe, expect, test } from "vitest";
import {
  BACKGROUND_TURN_HOLD_MS,
  BACKGROUND_TURN_TEXT,
  BACKGROUND_TURN_TEXT_COMPACT,
  type BackgroundTurnFacts,
  backgroundSendConfirm,
  backgroundTurnNoticeText,
  decideBackgroundTurnNotice,
  isBackgroundTurnOpen,
  runningUserText,
  turnCreditsLine,
  turnSilenceMs,
} from "./backgroundTurnNotice";
import type { ChatMessage } from "./model";
import { STALE_WARN_MS } from "./pure";

const NOW = 1_000_000;
const base: BackgroundTurnFacts = {
  turnOpen: true,
  transport: "connected",
  detached: false,
  silenceMs: 0,
  queuedCount: 0,
};
const decide = (over: Partial<BackgroundTurnFacts> = {}, lastTriggerAt: number | null = null) =>
  decideBackgroundTurnNotice({ ...base, ...over, lastTriggerAt, now: NOW });

describe("isBackgroundTurnOpen", () => {
  test("已受理、未终态、不在停止结算 → 在跑", () => {
    expect(isBackgroundTurnOpen({ _sendingInFlight: true }, null)).toBe(true);
  });

  test("不在飞 / 停止结算中 / 受理前(dispatch 非 null) / 没有会话 → 不算在跑", () => {
    expect(isBackgroundTurnOpen({ _sendingInFlight: false }, null)).toBe(false);
    expect(isBackgroundTurnOpen({}, null)).toBe(false);
    expect(
      isBackgroundTurnOpen(
        { _sendingInFlight: true, _stopSettlement: {} as never },
        null,
      ),
    ).toBe(false);
    expect(
      isBackgroundTurnOpen({ _sendingInFlight: true }, { phase: "sending", queued: 1, serviceStarting: false }),
    ).toBe(false);
    expect(isBackgroundTurnOpen(undefined, null)).toBe(false);
  });
});

describe("turnSilenceMs", () => {
  test("按最近一帧;没有帧按受理时刻;都没有为 0", () => {
    expect(turnSilenceMs({ _lastFrameAt: NOW - 5000, _turnStartedAt: NOW - 60_000 }, NOW)).toBe(5000);
    expect(turnSilenceMs({ _turnStartedAt: NOW - 60_000 }, NOW)).toBe(60_000);
    expect(turnSilenceMs({ _turnStartedAt: null }, NOW)).toBe(0);
    expect(turnSilenceMs({ _lastFrameAt: NOW + 10 }, NOW)).toBe(0);
  });
});

describe("decideBackgroundTurnNotice(B4-SPEC §3.2)", () => {
  test("不在飞 → 隐藏;在飞但帧新鲜、无排队 → 隐藏(正常流式交给活动行)", () => {
    expect(decide({ turnOpen: false, detached: true }).visible).toBe(false);
    expect(decide().visible).toBe(false);
    expect(decide({ silenceMs: STALE_WARN_MS - 1 }).visible).toBe(false);
  });

  test("(a) detached → 显示", () => {
    expect(decide({ detached: true })).toEqual({ visible: true, lastTriggerAt: NOW });
  });

  test("(b) 静默 ≥30s → 显示", () => {
    expect(decide({ silenceMs: STALE_WARN_MS }).visible).toBe(true);
    expect(decide({ silenceMs: 31_000 }).visible).toBe(true);
  });

  test("(c) 已有排队消息 → 显示", () => {
    expect(decide({ queuedCount: 1 }).visible).toBe(true);
  });

  test("(d) 快照实扣积分到 500 → 显示;未到不单独触发", () => {
    expect(decide({ creditsSettled: "500" }).visible).toBe(true);
    expect(decide({ creditsSettled: "499" }).visible).toBe(false);
  });

  test("断线 / 连接中 → 立即隐藏并清保持期(断线期间说「仍在运行」会撒谎)", () => {
    for (const transport of ["disconnected", "connecting"] as const) {
      expect(decide({ transport, detached: true, queuedCount: 2 }, NOW - 1000)).toEqual({
        visible: false,
        lastTriggerAt: null,
      });
    }
  });

  test("回合结束 → 立即隐藏,不走保持期", () => {
    expect(decide({ turnOpen: false }, NOW - 1000)).toEqual({ visible: false, lastTriggerAt: null });
  });

  test("触发消失后保持 10 秒才消失", () => {
    expect(decide({}, NOW - (BACKGROUND_TURN_HOLD_MS - 1))).toEqual({
      visible: true,
      lastTriggerAt: NOW - (BACKGROUND_TURN_HOLD_MS - 1),
    });
    expect(decide({}, NOW - BACKGROUND_TURN_HOLD_MS)).toEqual({ visible: false, lastTriggerAt: null });
  });
});

describe("文案(诚实、不复述阶段、不带积分)", () => {
  test("桌面 / 窄屏两版", () => {
    expect(backgroundTurnNoticeText(false)).toBe(BACKGROUND_TURN_TEXT);
    expect(backgroundTurnNoticeText(true)).toBe(BACKGROUND_TURN_TEXT_COMPACT);
    expect(BACKGROUND_TURN_TEXT).toBe("本轮仍在运行。现在发送的消息会等本轮结束后再发出，另行计费。");
    expect(BACKGROUND_TURN_TEXT_COMPACT).toBe("本轮仍在运行；新消息会等它结束再发，另行计费。");
  });

  test("不出现阶段词(由活动行说)、估算词和「停止后重新发送」", () => {
    const forbidden = /后台运行中|启动引擎|思考中|断开|已用|预计|约|积分|重新发送/;
    for (const text of [BACKGROUND_TURN_TEXT, BACKGROUND_TURN_TEXT_COMPACT]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

describe("runningUserText", () => {
  const user = (over: Partial<ChatMessage>): ChatMessage =>
    ({ id: "u", role: "user", text: "", ts: 0, ...over }) as ChatMessage;

  test("按 id 或 _clientMessageId 找正在运行的那条用户消息", () => {
    expect(
      runningUserText({ _activeClientMessageId: "c1", messages: [user({ id: "c1", text: "原问题" })] }),
    ).toBe("原问题");
    expect(
      runningUserText({
        _activeClientMessageId: "c1",
        messages: [user({ id: "srv-1", _clientMessageId: "c1", text: "服务端行" })],
      }),
    ).toBe("服务端行");
  });

  test("没有 active cmid、或找不到 → undefined;非 user 行不算", () => {
    expect(runningUserText({ messages: [user({ id: "c1", text: "x" })] })).toBeUndefined();
    expect(
      runningUserText({
        _activeClientMessageId: "c1",
        messages: [{ id: "c1", role: "assistant", text: "回答", ts: 0 } as ChatMessage],
      }),
    ).toBeUndefined();
  });
});

describe("backgroundSendConfirm(B4-SPEC §3.5)", () => {
  test("继续类:已连接说「还在运行」,断线说「可能还在运行」;正文复述用户这句", () => {
    const online = backgroundSendConfirm("nudge", " 继续 ", true);
    expect(online).toEqual({
      title: "本轮还在运行，确定再发一条？",
      body: "现在发送「继续」不会让它更快，只会在它结束后再开一轮，另行计费。可以先等本轮结束。",
      confirmText: "排队发送",
      cancelText: "先不发",
    });
    expect(backgroundSendConfirm("nudge", "在吗", false).title).toBe("本轮可能还在运行，确定再发一条？");
  });

  test("重复发送", () => {
    expect(backgroundSendConfirm("duplicate", "帮我写脚本", true)).toEqual({
      title: "这条和正在运行的那条相同",
      body: "重复发送不会让它更快，只会在它结束后再跑一轮，另行计费。",
      confirmText: "排队发送",
      cancelText: "先不发",
    });
  });

  test("这一版不报积分、不说估算词", () => {
    for (const opts of [
      backgroundSendConfirm("nudge", "继续", true),
      backgroundSendConfirm("duplicate", "x", false),
    ]) {
      expect(`${opts.title}${opts.body}`).not.toMatch(/积分|已用|预计|约/);
    }
  });
});

describe("积分(B4b:快照实扣,只说已扣)", () => {
  const credits = (over: Record<string, unknown> = {}) => ({
    _activeClientMessageId: "m-1",
    _turnCredits: { clientMessageId: "m-1", settled: "1520", requests: 3, asOf: NOW, receivedAt: NOW, ...over },
  });

  test("有积分时句首说「本轮已扣 N 积分」,其余与原文案一致", () => {
    expect(backgroundTurnNoticeText(false, turnCreditsLine(credits(), NOW, false)))
      .toBe("本轮已扣 1,520 积分，仍在运行。现在发送的消息会等本轮结束后再发出，另行计费。");
    expect(backgroundTurnNoticeText(true, turnCreditsLine(credits(), NOW, true)))
      .toBe("本轮已扣 1,520 积分，仍在运行；新消息会等它结束再发，另行计费。");
  });

  test("收到超过 60 秒标出截至时间", () => {
    expect(turnCreditsLine(credits({ receivedAt: NOW - 3 * 60_000 }), NOW, false)).toBe("本轮已扣 1,520 积分（截至 3 分钟前）");
    expect(turnCreditsLine(credits({ receivedAt: NOW - 3 * 60_000 }), NOW, true)).toBe("本轮已扣 1,520 积分（3 分钟前）");
  });

  test("别的回合 / 无结算 / 0 积分不显示数字", () => {
    expect(turnCreditsLine(credits({ clientMessageId: "m-0" }), NOW, false)).toBeNull();
    expect(turnCreditsLine(credits({ requests: 0 }), NOW, false)).toBeNull();
    expect(turnCreditsLine(credits({ settled: "0" }), NOW, false)).toBeNull();
    expect(turnCreditsLine({ _activeClientMessageId: "m-1" }, NOW, false)).toBeNull();
  });
});
