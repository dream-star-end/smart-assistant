import { describe, expect, it } from "vitest";
import { formatCompactAge, sessionAgeTimestamp } from "./compactAge";

describe("formatCompactAge", () => {
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);

  it("小于 1 分钟显示 1m，不出现 0m", () => {
    expect(formatCompactAge(now, now)).toBe("1m");
    expect(formatCompactAge(now - 20_000, now)).toBe("1m");
    expect(formatCompactAge(now - 59_999, now)).toBe("1m");
  });

  it("小于 60 分钟用 Nm", () => {
    expect(formatCompactAge(now - 60_000, now)).toBe("1m");
    expect(formatCompactAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatCompactAge(now - 59 * 60_000, now)).toBe("59m");
  });

  it("小于 24 小时用 Nh", () => {
    expect(formatCompactAge(now - 60 * 60_000, now)).toBe("1h");
    expect(formatCompactAge(now - 2 * 60 * 60_000, now)).toBe("2h");
    expect(formatCompactAge(now - 23 * 60 * 60_000, now)).toBe("23h");
  });

  it("满 24 小时起用 Nd", () => {
    expect(formatCompactAge(now - 24 * 60 * 60_000, now)).toBe("1d");
    expect(formatCompactAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3d");
  });
});

describe("sessionAgeTimestamp", () => {
  it("运行中优先 runStartedAt，否则 lastAt，再回落 updatedAt", () => {
    expect(sessionAgeTimestamp({ lastAt: 20, updatedAt: "2020-01-01T00:00:00.000Z" }, true, 10)).toBe(10);
    expect(sessionAgeTimestamp({ lastAt: 20, updatedAt: "2020-01-01T00:00:00.000Z" }, true)).toBe(20);
    expect(sessionAgeTimestamp({ updatedAt: "2020-01-01T00:00:00.000Z" }, false)).toBe(
      Date.parse("2020-01-01T00:00:00.000Z"),
    );
    expect(sessionAgeTimestamp({}, false)).toBeNull();
  });
});
