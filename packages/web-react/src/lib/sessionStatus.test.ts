import { describe, expect, it } from "vitest";
import { deriveLiveTerminalFromMessages, resolveSessionStatus } from "./sessionStatus";

describe("resolveSessionStatus", () => {
  it("运行中优先于任何终态（本 tab 正在发送必须立刻闪绿）", () => {
    expect(
      resolveSessionStatus({
        running: true,
        lastOutcome: "crashed",
        lastErrorCode: "SERVICE_RESTART",
      }),
    ).toBe("running");
  });

  it("从未跑过 turn（lastOutcome 空）不显示点", () => {
    expect(resolveSessionStatus({ lastOutcome: null })).toBe("none");
    expect(resolveSessionStatus({})).toBe("none");
    expect(resolveSessionStatus({ lastOutcome: "" })).toBe("none");
  });

  it("正常结束：completed → completed，用户停止 interrupted → interrupted（都是绿点，文案不同）", () => {
    expect(resolveSessionStatus({ lastOutcome: "completed" })).toBe("completed");
    expect(resolveSessionStatus({ lastOutcome: "interrupted" })).toBe("interrupted");
    expect(resolveSessionStatus({ lastOutcome: "COMPLETED" })).toBe("completed");
  });

  it("异常结束：crashed / executed_error / not_accepted → error", () => {
    expect(resolveSessionStatus({ lastOutcome: "crashed" })).toBe("error");
    expect(resolveSessionStatus({ lastOutcome: "executed_error" })).toBe("error");
    expect(resolveSessionStatus({ lastOutcome: "not_accepted" })).toBe("error");
  });

  it("服务重启中断：归一化后 service_restart 标琥珀，即使 lastOutcome 是 crashed", () => {
    expect(resolveSessionStatus({ lastOutcome: "crashed", lastErrorCode: "SERVICE_RESTART" })).toBe(
      "service_restart",
    );
    expect(
      resolveSessionStatus({ lastOutcome: "executed_error", lastErrorCode: "service_restart" }),
    ).toBe("service_restart");
  });

  it("running=false 且非重启错误码时走 outcome", () => {
    expect(
      resolveSessionStatus({
        running: false,
        lastOutcome: "completed",
        lastErrorCode: "rate_limited",
      }),
    ).toBe("completed");
  });
});

describe("deriveLiveTerminalFromMessages", () => {
  it("倒序取最近终态，跳过 turn_status 阶段提示", () => {
    expect(
      deriveLiveTerminalFromMessages([
        { _dispatchOutcome: "completed" },
        { _turnStatusRecord: true, _errorCode: "whatever" },
      ]),
    ).toEqual({ lastOutcome: "completed", lastErrorCode: null });
  });

  it("service_restart 错误码优先于 outcome 缺省", () => {
    expect(deriveLiveTerminalFromMessages([{ _errorCode: "SERVICE_RESTART" }])).toEqual({
      lastOutcome: "crashed",
      lastErrorCode: "SERVICE_RESTART",
    });
  });

  it("outbound.error 无 dispatchOutcome 时记 executed_error", () => {
    expect(deriveLiveTerminalFromMessages([{ _errorCode: "runner_crashed" }])).toEqual({
      lastOutcome: "executed_error",
      lastErrorCode: "runner_crashed",
    });
  });
});
