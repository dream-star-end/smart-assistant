import { describe, expect, it } from "vitest";
import { formatCompactDuration, sessionDurationWindow } from "./compactDuration";

describe("formatCompactDuration", () => {
  it("小于 1 分钟显示 1分，不出现 0分", () => {
    expect(formatCompactDuration(0)).toBe("1分");
    expect(formatCompactDuration(20_000)).toBe("1分");
    expect(formatCompactDuration(59_999)).toBe("1分");
  });

  it("按分、小时、天用中文单位紧凑展示（SR-01：中文界面不混英文缩写）", () => {
    expect(formatCompactDuration(5 * 60_000)).toBe("5分");
    expect(formatCompactDuration(59 * 60_000)).toBe("59分");
    expect(formatCompactDuration(2 * 60 * 60_000)).toBe("2小时");
    expect(formatCompactDuration(23 * 60 * 60_000)).toBe("23小时");
    expect(formatCompactDuration(3 * 24 * 60 * 60_000)).toBe("3天");
  });
});

describe("sessionDurationWindow", () => {
  const startAt = Date.UTC(2026, 7, 20, 10, 0, 0);
  const lastAt = Date.UTC(2026, 7, 20, 10, 35, 0);
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);

  it("结束会话使用 createdAt → lastAt", () => {
    expect(sessionDurationWindow({ createdAt: startAt, lastAt }, false, now)).toEqual({
      startAt,
      endAt: lastAt,
    });
  });

  it("运行中会话使用 createdAt → 当前时间", () => {
    expect(sessionDurationWindow({ createdAt: startAt, lastAt }, true, now)).toEqual({
      startAt,
      endAt: now,
    });
  });

  it("lastAt 缺失时回落 updatedAt；createdAt 缺失时不伪造用时", () => {
    expect(
      sessionDurationWindow(
        { createdAt: startAt, updatedAt: new Date(lastAt).toISOString() },
        false,
        now,
      ),
    ).toEqual({ startAt, endAt: lastAt });
    expect(sessionDurationWindow({ lastAt }, false, now)).toBeNull();
  });

  it("异常结束时间早于开始时间时收敛为 1m 展示窗口", () => {
    expect(sessionDurationWindow({ createdAt: startAt, lastAt: startAt - 1 }, false, now)).toEqual({
      startAt,
      endAt: startAt,
    });
  });
});
