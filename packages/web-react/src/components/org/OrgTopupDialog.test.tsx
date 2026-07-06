import { describe, expect, test } from "vitest";
import { yuanToCents } from "./OrgTopupDialog";

describe("yuanToCents（元 → 分，纯字符串/BigInt，禁浮点）", () => {
  test("整数元换算", () => {
    expect(yuanToCents("100")).toBe("10000");
    expect(yuanToCents("1")).toBe("100");
    expect(yuanToCents("5000")).toBe("500000");
  });

  test("两位小数换算精确", () => {
    expect(yuanToCents("123.45")).toBe("12345");
    expect(yuanToCents("0.01")).toBe("1");
    expect(yuanToCents("99.9")).toBe("9990"); // 一位小数补零
  });

  test("首尾空白容忍", () => {
    expect(yuanToCents("  88  ")).toBe("8800");
  });

  test("超大金额不丢精度（越过 2^53）", () => {
    // 90071992547409.92 元 → 9007199254740992 分（> Number.MAX_SAFE_INTEGER）
    expect(yuanToCents("90071992547409.92")).toBe("9007199254740992");
  });

  test("非法 / 非正 → null", () => {
    expect(yuanToCents("")).toBeNull();
    expect(yuanToCents("0")).toBeNull();
    expect(yuanToCents("0.00")).toBeNull();
    expect(yuanToCents("-5")).toBeNull();
    expect(yuanToCents("1.234")).toBeNull(); // 超过两位小数
    expect(yuanToCents("abc")).toBeNull();
    expect(yuanToCents("1,000")).toBeNull();
    expect(yuanToCents("1e3")).toBeNull();
  });
});
