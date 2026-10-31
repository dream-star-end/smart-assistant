import { afterEach, describe, expect, it } from "vitest";
import {
  browserTimeZone,
  displayTimeZone,
  formatLedgerShort,
  formatZoned,
  setDisplayTimeZonePreference,
  timeZoneFromPrefs,
  zonedDayIndex,
  zonedHour,
} from "./displayTime";

afterEach(() => setDisplayTimeZonePreference(undefined));

describe("displayTime", () => {
  it("没设偏好时是北京时间，非法值也回到北京时间", () => {
    expect(displayTimeZone()).toBe("Asia/Shanghai");
    setDisplayTimeZonePreference("Not/AZone");
    expect(displayTimeZone()).toBe("Asia/Shanghai");
    setDisplayTimeZonePreference("America/New_York");
    expect(displayTimeZone()).toBe("America/New_York");
  });

  it("偏好快照可以是包一层或平铺，缺字段就清除", () => {
    timeZoneFromPrefs({ prefs: { timezone: "Asia/Taipei" } });
    expect(displayTimeZone()).toBe("Asia/Taipei");
    timeZoneFromPrefs({ timezone: "UTC" });
    expect(displayTimeZone()).toBe("UTC");
    timeZoneFromPrefs({ prefs: { theme: "dark" } });
    expect(displayTimeZone()).toBe("Asia/Shanghai");
    timeZoneFromPrefs(null);
    expect(displayTimeZone()).toBe("Asia/Shanghai");
  });

  it("此浏览器存的是解析出来的 IANA 名", () => {
    const tz = browserTimeZone();
    expect(tz.length).toBeGreaterThan(0);
    setDisplayTimeZonePreference(tz);
    expect(displayTimeZone()).toBe(tz);
  });

  it("UTC / 台北 / 美东跨日", () => {
    expect(formatZoned(new Date("2026-10-30T23:59:00Z"), "datetime", "UTC")).toBe("2026-10-30 23:59");
    expect(formatZoned(new Date("2026-10-31T00:01:00Z"), "datetime", "UTC")).toBe("2026-10-31 00:01");
    expect(formatZoned(new Date("2026-10-30T15:59:00Z"), "full", "Asia/Taipei")).toBe(
      "2026-10-30 23:59:00",
    );
    expect(formatZoned(new Date("2026-10-30T16:01:00Z"), "full", "Asia/Taipei")).toBe(
      "2026-10-31 00:01:00",
    );
    expect(formatZoned(new Date("2026-10-31T03:59:00Z"), "datetime", "America/New_York")).toBe(
      "2026-10-30 23:59",
    );
    expect(formatZoned(new Date("2026-10-31T04:01:00Z"), "datetime", "America/New_York")).toBe(
      "2026-10-31 00:01",
    );
  });

  it("美东 2026 年春令开始缺 2 点、秋令结束重复 1 点", () => {
    expect(formatZoned(new Date("2026-03-08T06:59:00Z"), "time", "America/New_York")).toBe("01:59");
    expect(formatZoned(new Date("2026-03-08T07:00:00Z"), "time", "America/New_York")).toBe("03:00");
    expect(formatZoned(new Date("2026-11-01T05:30:00Z"), "time", "America/New_York")).toBe("01:30");
    expect(formatZoned(new Date("2026-11-01T06:30:00Z"), "time", "America/New_York")).toBe("01:30");
  });

  it("零点写成 00，不写成 24", () => {
    expect(formatZoned(new Date("2026-10-28T16:00:00Z"), "time", "Asia/Shanghai")).toBe("00:00");
    expect(formatLedgerShort(new Date("2026-10-28T16:05:00.000Z"), "Asia/Shanghai")).toBe(
      "10月29日 00:05",
    );
    expect(formatLedgerShort(new Date("2026-10-29T03:12:24.566Z"))).toBe("10月29日 11:12");
  });

  it("体验官那一刻：台北是中午，美东和 UTC 是夜里，并且已经跨日", () => {
    const at = new Date("2026-10-31T03:40:00Z");
    expect(zonedHour(at, "Asia/Taipei")).toBe(11);
    expect(formatZoned(at, "datetime", "Asia/Taipei")).toBe("2026-10-31 11:40");
    expect(zonedHour(at, "America/New_York")).toBe(23);
    expect(formatZoned(at, "datetime", "America/New_York")).toBe("2026-10-30 23:40");
    expect(zonedHour(at, "UTC")).toBe(3);
    expect(zonedDayIndex(new Date("2026-10-30T15:59:00Z"), "Asia/Taipei")).toBe(
      zonedDayIndex(new Date("2026-10-30T12:00:00Z"), "Asia/Taipei"),
    );
    expect(zonedDayIndex(new Date("2026-10-30T16:01:00Z"), "Asia/Taipei")).toBe(
      zonedDayIndex(new Date("2026-10-30T15:59:00Z"), "Asia/Taipei") + 1,
    );
  });
});
