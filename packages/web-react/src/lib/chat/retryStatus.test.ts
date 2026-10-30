import { AUTOMATIC_TURN_RETRY_MAX, automaticRetryStatus } from "@openclaude/protocol/browser";
import { describe, expect, test } from "vitest";
import { addMessage, createSession, type ChatSession } from "./model";
import {
  activeTurnStatus,
  applyRecoveryStatusFrame,
  readRetryStatus,
  rememberRetryStatus,
  retryActivityLabel,
} from "./retryStatus";

function sess(): ChatSession {
  const s = createSession({ id: "s1", agentId: "main" });
  addMessage(s, "user", "原问题", { id: "root" });
  addMessage(s, "user", "（自动续接）", {
    id: "m-recover-2",
    _automaticRecovery: true,
    _recoveryOfClientMessageId: "root",
    _automaticRecoveryRootClientMessageId: "root",
  });
  return s;
}

function retrying(s: ChatSession, active: string, attempt = 2) {
  s._sendingInFlight = true;
  s._activeClientMessageId = active;
  s._turnStatus = { kind: "retrying", attempt, max: AUTOMATIC_TURN_RETRY_MAX, retryAt: Date.now() };
}

describe("retryStatus 各状态", () => {
  test("scheduled / running 带实际 N", () => {
    expect(readRetryStatus({ state: "scheduled", attempt: 2, maxAttempts: 3 })?.message).toBe("正在等待自动重试（2/3），请稍候。");
    expect(readRetryStatus({ state: "running", attempt: 2, maxAttempts: 3 })?.message).toBe("正在自动重试（2/3）。");
  });

  test("旧 job 没有实际上限:只说第几次,不编 N", () => {
    const status = readRetryStatus({ state: "running", attempt: 4 });
    expect(status?.message).toBe("正在自动重试（第 4 次）。");
    expect(status?.maxAttempts).toBeUndefined();
  });

  test("暂停 / 耗尽给出口动作;拒绝不给", () => {
    expect(readRetryStatus({ state: "paused" })?.actions).toEqual(["switch_model", "retry", "contact_admin"]);
    expect(readRetryStatus({ state: "exhausted", attempt: 3, maxAttempts: 3 })?.actions)
      .toEqual(["switch_model", "retry", "contact_admin"]);
    expect(readRetryStatus({ state: "declined" })?.actions).toEqual([]);
  });

  test("服务端文案优先;不认识的状态不采信", () => {
    expect(readRetryStatus({ state: "running", attempt: 1, maxAttempts: 2, message: "新版文案" })?.message).toBe("新版文案");
    expect(readRetryStatus({ state: "retrying", attempt: 1 })).toBeUndefined();
    expect(readRetryStatus(null)).toBeUndefined();
  });
});

describe("按根消息归并", () => {
  test("sys.recovery_status 记到根消息上,重放的旧帧不把进度往回拨", () => {
    const s = sess();
    const frame = (attempt: number, ts: number) => ({
      type: "sys.recovery_status" as const,
      peer: { id: "s1", kind: "dm" as const },
      sourceClientMessageId: "root",
      rootClientMessageId: "root",
      clientMessageId: `m-recover-${attempt}`,
      retryStatus: { state: "running" as const, attempt, maxAttempts: 3, message: `正在自动重试（${attempt}/3）。`, actions: [] },
      ts,
    });
    expect(applyRecoveryStatusFrame(s, frame(2, 200))).toBe(true);
    expect(applyRecoveryStatusFrame(s, frame(1, 100))).toBe(false);
    expect(applyRecoveryStatusFrame(s, frame(1, 300))).toBe(false);
    expect(s._automaticRetryStatus?.status.attempt).toBe(2);
    expect(applyRecoveryStatusFrame(s, frame(3, 400))).toBe(true);
    expect(s._automaticRetryStatus).toMatchObject({ rootClientMessageId: "root", clientMessageId: "m-recover-3" });
  });

  test("只有子轮 id 时按血统找到根消息", () => {
    const s = sess();
    expect(rememberRetryStatus(s, { clientMessageId: "m-recover-2" }, { state: "scheduled", attempt: 2, maxAttempts: 5 })).toBe(true);
    expect(s._automaticRetryStatus?.rootClientMessageId).toBe("root");
  });
});

describe("显示「正在自动重试（n/N）」", () => {
  test("当前回合正在重试且有真实进度 → n/N", () => {
    const s = sess();
    retrying(s, "m-recover-2");
    rememberRetryStatus(s, { rootClientMessageId: "root", clientMessageId: "m-recover-2" }, { state: "running", attempt: 2, maxAttempts: 3 });
    const status = activeTurnStatus(s);
    expect(status).toMatchObject({ kind: "retrying", retryStatus: { attempt: 2, maxAttempts: 3 } });
    expect(retryActivityLabel(status as never)).toBe("正在自动重试（2/3）。");
  });

  test("没有服务端进度:不写次数,不拿兼容常量 10 冒充 N", () => {
    const s = sess();
    retrying(s, "m-recover-2", 2);
    const label = retryActivityLabel(activeTurnStatus(s) as never);
    expect(label).toBe("正在自动重试…");
    expect(label).not.toMatch(/\d/);
  });

  test("别的回合的进度不附到当前回合", () => {
    const s = sess();
    addMessage(s, "user", "新问题", { id: "other" });
    retrying(s, "other", 1);
    rememberRetryStatus(s, { rootClientMessageId: "root" }, { state: "running", attempt: 2, maxAttempts: 3 });
    expect(activeTurnStatus(s)).toEqual(s._turnStatus);
  });

  test("不在重试中时原样返回阶段状态", () => {
    const s = sess();
    s._turnStatus = "compacting";
    rememberRetryStatus(s, { rootClientMessageId: "root" }, { state: "running", attempt: 2, maxAttempts: 3 });
    expect(activeTurnStatus(s)).toBe("compacting");
  });

  test("终态进度(耗尽)不在重试行里冒充「正在重试」", () => {
    expect(retryActivityLabel({ retryStatus: automaticRetryStatus("exhausted", 3, 3) })).toBe("正在自动重试…");
  });
});
