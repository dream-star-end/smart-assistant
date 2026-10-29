import { describe, expect, test } from "vitest";
import {
  NUDGE_MAX_CHARS,
  classifyBackgroundSend,
  isContinuationNudge,
  isDuplicateOfRunning,
  normalizeNudgeText,
} from "./continuationNudge";

describe("isContinuationNudge(B4-SPEC §3.5)", () => {
  test.each([
    "继续",
    "继续。",
    "请继续！",
    "接着写",
    "Go on",
    "CONTINUE",
    "keep going",
    "？",
    "??",
    "……",
    "!!!",
    "～",
    "还在吗",
    "好了吗？",
    "卡住了吗",
    "在不在?",
    "进度呢",
    "  继续吧  ",
    "1",
    "ping",
  ])("催促/续写类「%s」→ 命中", (text) => {
    expect(isContinuationNudge(text)).toBe(true);
  });

  test.each([
    "继续优化第三段的措辞",
    "继续用 Python 实现",
    "另外帮我查一下 X",
    "好的",
    "谢谢",
    "",
    "   ",
    "#$%",
    "继续".repeat(11),
  ])("带具体指令 / 非催促「%s」→ 不命中", (text) => {
    expect(isContinuationNudge(text)).toBe(false);
  });

  test("原文超过上限即不算,哪怕归一化后命中词表", () => {
    const padded = `继续${"。".repeat(NUDGE_MAX_CHARS - 1)}`;
    expect(padded.length).toBeGreaterThan(NUDGE_MAX_CHARS);
    expect(normalizeNudgeText(padded)).toBe("继续");
    expect(isContinuationNudge(padded)).toBe(false);
  });

  test("归一化:NFKC + 小写 + 去标点/符号/空白", () => {
    expect(normalizeNudgeText(" Ｇｏ　Ｏｎ！ ")).toBe("goon");
    expect(normalizeNudgeText("好了吗？？")).toBe("好了吗");
  });
});

describe("isDuplicateOfRunning", () => {
  test("归一化后与正在运行的那条相同才算重复", () => {
    expect(isDuplicateOfRunning("帮我写个部署脚本。", "帮我写个部署脚本")).toBe(true);
    expect(isDuplicateOfRunning(" 帮我写个部署脚本 ", "帮我写个部署脚本！")).toBe(true);
    expect(isDuplicateOfRunning("帮我写个部署脚本，用 bash", "帮我写个部署脚本")).toBe(false);
  });

  test("找不到正在运行的原文、或归一化后为空 → 不算重复", () => {
    expect(isDuplicateOfRunning("帮我写个部署脚本", undefined)).toBe(false);
    expect(isDuplicateOfRunning("？", "？")).toBe(false);
  });
});

describe("classifyBackgroundSend", () => {
  test("催促 → nudge;重复 → duplicate;实质新问题 → null", () => {
    expect(classifyBackgroundSend({ text: "继续", hasMedia: false })).toBe("nudge");
    expect(
      classifyBackgroundSend({ text: "把日志整理成表格", hasMedia: false, runningText: "把日志整理成表格" }),
    ).toBe("duplicate");
    expect(
      classifyBackgroundSend({ text: "另外帮我查一下 X", hasMedia: false, runningText: "把日志整理成表格" }),
    ).toBeNull();
  });

  test("带附件不确认", () => {
    expect(classifyBackgroundSend({ text: "继续", hasMedia: true })).toBeNull();
    expect(classifyBackgroundSend({ text: "同一条", hasMedia: true, runningText: "同一条" })).toBeNull();
  });
});
