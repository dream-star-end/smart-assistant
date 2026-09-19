import { describe, expect, test } from "vitest";
import { formatDurationSeconds, speechLangFor } from "./pure";

describe("speechLangFor(朗读语言粗判)", () => {
  test("中文正文 → zh-CN", () => {
    expect(speechLangFor("两者是单写者与篱笆的关系。")).toBe("zh-CN");
  });

  test("纯英文正文 → en-US(否则中文语音会逐字母拼读)", () => {
    expect(speechLangFor("The controller is the only programmatic writer of scrollTop.")).toBe("en-US");
  });

  test("中英混排按「汉字数 vs 拉丁词数」判,长标识符不带偏", () => {
    expect(speechLangFor("调用 stickToBottom 与 wheelFence 即可")).toBe("zh-CN");
    expect(speechLangFor("Run `npm run typecheck` 后再看 README")).toBe("en-US");
  });

  test("空文本 / 只有数字标点 → 回退 zh-CN", () => {
    expect(speechLangFor("")).toBe("zh-CN");
    expect(speechLangFor("42 · 2026-09-15")).toBe("zh-CN");
  });
});

describe("formatDurationSeconds(目标卡用时)", () => {
  test.each([
    [0, "0s"],
    [45, "45s"],
    [60, "1 分钟"],
    [1260, "21 分钟"],
    [1290, "22 分钟"],
    [3600, "1 小时"],
    [5400, "1 小时 30 分"],
  ])("%s 秒 → %s", (seconds, expected) => {
    expect(formatDurationSeconds(seconds)).toBe(expected);
  });

  test("非法输入 → 空串", () => {
    expect(formatDurationSeconds(-1)).toBe("");
    expect(formatDurationSeconds(Number.NaN)).toBe("");
    expect(formatDurationSeconds(undefined)).toBe("");
  });
});
