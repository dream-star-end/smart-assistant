import { describe, expect, it } from "vitest";
import { buildSchedule, cronHuman, scheduleToPreset } from "./cron";

describe("cronHuman", () => {
  it("每天定点", () => expect(cronHuman("0 9 * * *")).toBe("每天 09:00"));
  it("每周单日", () => expect(cronHuman("30 9 * * 1")).toBe("每周一 09:30"));
  it("每周多日", () => expect(cronHuman("0 9 * * 1,3,5")).toBe("每周一、三、五 09:00"));
  it("某月某日", () => expect(cronHuman("0 8 15 6 *")).toBe("6月15日 08:00"));
  it("每月某日", () => expect(cronHuman("0 8 1 * *")).toBe("每月1日 08:00"));
  it("非法回退原串", () => expect(cronHuman("nope")).toBe("nope"));
  it("空串", () => expect(cronHuman("")).toBe(""));
  // ── 步进（*/N）支持（仅日/月/周均为 * 的清晰形态）──
  it("时位步进带分钟(真实 skill-check 排程) → 每 N 小时的第 M 分", () =>
    expect(cronHuman("47 */6 * * *")).toBe("每 6 小时的第 47 分"));
  it("分位步进 → 每 N 分钟", () => expect(cronHuman("*/15 * * * *")).toBe("每 15 分钟"));
  it("分位步进(单数字) → 每 N 分钟", () => expect(cronHuman("*/5 * * * *")).toBe("每 5 分钟"));
  it("时位步进且分位 * → 每 N 小时", () => expect(cronHuman("* */6 * * *")).toBe("每 6 小时"));
  it("时位步进带分钟 0 → 每 N 小时的第 0 分(不臆测收整)", () =>
    expect(cronHuman("0 */2 * * *")).toBe("每 2 小时的第 0 分"));
  // ── 无法明确表达的复杂形态 → 回退原串，不臆测 ──
  it("range 字段回退", () => expect(cronHuman("0 9 * * 1-5")).toBe("0 9 * * 1-5"));
  it("分位步进 + 固定时位回退(歧义)", () => expect(cronHuman("*/15 9 * * *")).toBe("*/15 9 * * *"));
  it("时位步进 + 固定日回退", () => expect(cronHuman("0 */2 15 * *")).toBe("0 */2 15 * *"));
  it("日位 step 回退", () => expect(cronHuman("0 9 */2 * *")).toBe("0 9 */2 * *"));
  it("周位 step 回退", () => expect(cronHuman("0 9 * * */2")).toBe("0 9 * * */2"));
  it("步长越界回退(*/99 分钟)", () => expect(cronHuman("*/99 * * * *")).toBe("*/99 * * * *"));
  it("非 5 段回退", () => expect(cronHuman("0 9 * * * *")).toBe("0 9 * * * *"));
  it("越界数字回退", () => expect(cronHuman("60 25 * * *")).toBe("60 25 * * *"));
});

describe("buildSchedule", () => {
  // 用带偏移的绝对时刻，断言与运行机器时区无关：模拟北京时间 2026-06-28 09:25。
  const now = new Date("2026-06-28T09:25:00+08:00");

  it("daily → 重复", () =>
    expect(buildSchedule("daily", { time: "09:00" })).toEqual({ schedule: "0 9 * * *", oneshot: false }));
  it("weekly → 带星期", () =>
    expect(buildSchedule("weekly", { time: "09:30", weekday: 1 })).toEqual({
      schedule: "30 9 * * 1",
      oneshot: false,
    }));
  // after/once 换算成上海挂钟分量（Asia/Shanghai），与机器时区无关。
  it("after → 一次性，上海挂钟", () =>
    expect(buildSchedule("after", { minutes: 10, now })).toEqual({ schedule: "35 9 28 6 *", oneshot: true }));
  it("once → 一次性，上海挂钟", () =>
    expect(buildSchedule("once", { at: "2026-06-28T10:00:00+08:00", now })).toEqual({
      schedule: "0 10 28 6 *",
      oneshot: true,
    }));
  it("once 过去时间报错", () =>
    expect(() => buildSchedule("once", { at: "2026-06-28T09:00:00+08:00", now })).toThrow(/过去/));
  it("once 超过一年报错（5 段 cron 无年份）", () =>
    expect(() => buildSchedule("once", { at: "2027-07-01T10:00:00+08:00", now })).toThrow(/一年内/));
  it("after 超过一年报错", () =>
    expect(() => buildSchedule("after", { minutes: 600000, now })).toThrow(/一年内/));
  it("advanced 透传 + oneshot", () =>
    expect(buildSchedule("advanced", { cron: "0 9 * * 1", oneshot: true })).toEqual({
      schedule: "0 9 * * 1",
      oneshot: true,
    }));
  it("advanced 非 5 段报错", () => expect(() => buildSchedule("advanced", { cron: "0 9" })).toThrow(/5 段/));
  it("daily 缺时间报错", () => expect(() => buildSchedule("daily", {})).toThrow());
  it("weekly 非法星期报错", () =>
    expect(() => buildSchedule("weekly", { time: "09:00", weekday: 9 })).toThrow(/星期/));
  it("after 缺分钟报错", () => expect(() => buildSchedule("after", {})).toThrow(/分钟/));
});

describe("scheduleToPreset", () => {
  it("recovers daily/weekly presets produced by buildSchedule", () => {
    expect(scheduleToPreset("30 9 * * *")).toEqual({ mode: "daily", time: "09:30", weekday: 1 });
    expect(scheduleToPreset("0 18 * * 5")).toEqual({ mode: "weekly", time: "18:00", weekday: 5 });
  });

  it("refuses complex/out-of-range forms (edit form falls back to advanced)", () => {
    expect(scheduleToPreset("*/5 * * * *")).toBeNull();
    expect(scheduleToPreset("0 9 1 * *")).toBeNull(); // 月内固定日
    expect(scheduleToPreset("0 9 * * 1,3")).toBeNull(); // 多星期
    expect(scheduleToPreset("99 9 * * *")).toBeNull();
    expect(scheduleToPreset("")).toBeNull();
    expect(scheduleToPreset(undefined)).toBeNull();
  });
});
