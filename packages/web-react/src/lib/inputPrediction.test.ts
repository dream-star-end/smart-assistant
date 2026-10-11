import { describe, expect, test } from "vitest";
import { uiFencesToMarkdown } from "../components/iui/toMarkdown";
import { completionFor, isNextBlockCode, nextPredictionOf, predictInput, suggestionItemsOf } from "./inputPrediction";

const ui = (json: string) => `\`\`\`ui\n${json}\n\`\`\``;
const NEXT = ui('{"type":"next","text":"把木星的卫星也加上"}');
const SUGG = ui('{"type":"suggestions","items":["改成可以拖着旋转的三维太阳系","加上木星的四颗伽利略卫星"]}');

const user = (text: string, status?: string) => ({ role: "user", text, ...(status ? { status } : {}) });
const assistant = (text: string) => ({ role: "assistant", text });

describe("isNextBlockCode", () => {
  test("完整的 next / prediction 块;空白与大小写不敏感", () => {
    expect(isNextBlockCode('{"type":"next","text":"好的"}')).toBe(true);
    expect(isNextBlockCode('{\n  "type" : "Next",\n  "text": "x"\n}')).toBe(true);
    expect(isNextBlockCode('{"type":"prediction","text":"x"}')).toBe(true);
    expect(isNextBlockCode('{"type":"suggestions","items":["x"]}')).toBe(false);
    expect(isNextBlockCode('{"type":"notes"}')).toBe(false);
  });
  test("流式中类型名还没写完、可能是 next 时也算(不先闪骨架);写出别的类型就不算", () => {
    expect(isNextBlockCode('{"type":"ne', true)).toBe(true);
    expect(isNextBlockCode("", true)).toBe(true);
    expect(isNextBlockCode('{"type":"ne', false)).toBe(false);
    expect(isNextBlockCode('{"type":"ta', true)).toBe(false);
  });
});

describe("nextPredictionOf / suggestionItemsOf", () => {
  test("取最后一个 next 块的 text;没有或为空 → null", () => {
    expect(nextPredictionOf(`正文\n\n${ui('{"type":"next","text":"甲"}')}\n\n${NEXT}`)).toBe("把木星的卫星也加上");
    expect(nextPredictionOf(ui('{"type":"next","text":"  "}'))).toBeNull();
    expect(nextPredictionOf("没有块")).toBeNull();
  });
  test("未闭合(还在写)的块、其它语言围栏里的 ```ui 字样都不算;容忍尾逗号", () => {
    expect(nextPredictionOf('```ui\n{"type":"next","text":"半截"}')).toBeNull();
    expect(nextPredictionOf('````md\n```ui\n{"type":"next","text":"x"}\n```\n````')).toBeNull();
    expect(nextPredictionOf(ui('{"type":"next","text":"好的",}'))).toBe("好的");
  });
  test("suggestions:多个块时最后一块在前;别名、数字、空串", () => {
    const text = `${ui('{"type":"suggestions","items":["甲"]}')}\n${ui('{"type":"followups","suggestions":["乙", 3, " "]}')}`;
    expect(suggestionItemsOf(text)).toEqual(["乙", "3", "甲"]);
  });
});

describe("predictInput", () => {
  test("回答末尾有 next 块 → 助手的预测;候选 = 预测 + 接着问 + 自己发过的话", () => {
    const p = predictInput([user("做一个带动画的太阳系"), assistant(`做好了。\n\n${SUGG}\n\n${NEXT}`)]);
    expect(p.next).toEqual({ text: "把木星的卫星也加上", source: "agent" });
    expect(p.candidates).toEqual([
      "把木星的卫星也加上",
      "改成可以拖着旋转的三维太阳系",
      "加上木星的四颗伽利略卫星",
      "做一个带动画的太阳系",
    ]);
  });

  test("没写 next 块 → 退回接着问第一条;两样都没有 → null", () => {
    expect(predictInput([user("q"), assistant(`a\n\n${SUGG}`)]).next).toEqual({
      text: "改成可以拖着旋转的三维太阳系",
      source: "suggestion",
    });
    expect(predictInput([user("q"), assistant("写好了。要不要我再加上日志？")]).next).toBeNull();
  });

  test("用户刚发出、回答还没内容 → 不给整句预测(上一轮的已过期)", () => {
    const p = predictInput([user("做一个太阳系"), assistant(`好了\n\n${NEXT}`), user("加上卫星")]);
    expect(p.next).toBeNull();
    expect(p.candidates).toEqual(["加上卫星", "做一个太阳系"]);
  });

  test("回答分几段(中间有工具)时看最后一段;过长的预测不用", () => {
    const long = ui(`{"type":"next","text":"${"很".repeat(81)}"}`);
    expect(predictInput([user("q"), assistant(NEXT), { role: "tool", text: "Bash" }, assistant(`收尾\n\n${long}`)]).next).toBeNull();
  });

  test("排队中的消息不算已发送;多行、超长、重复的历史不进候选", () => {
    const p = predictInput([user("第一句"), user("两行\n消息"), user("很".repeat(81)), user("第一句"), user("排队的", "queued")]);
    expect(p.candidates).toEqual(["第一句"]);
  });

  test("空时间线", () => {
    expect(predictInput([])).toEqual({ next: null, candidates: [] });
  });
});

describe("completionFor", () => {
  const cands = ["加上木星的四颗伽利略卫星", "Refactor the parser"];
  test("前缀命中 → 剩下的部分;拉丁字母不分大小写", () => {
    expect(completionFor("加上", cands)).toBe("木星的四颗伽利略卫星");
    expect(completionFor("refac", cands)).toBe("tor the parser");
  });
  test("太短、未命中、已完整、多行 → null", () => {
    expect(completionFor("加", cands)).toBeNull();
    expect(completionFor("re", cands)).toBeNull();
    expect(completionFor("加入", cands)).toBeNull();
    expect(completionFor("加上木星的四颗伽利略卫星", cands)).toBeNull();
    expect(completionFor("加上\n", cands)).toBeNull();
    expect(completionFor("", cands)).toBeNull();
  });
});

describe("next 块不进复制 / 导出 / 关闭组件时的文字版", () => {
  test("uiFencesToMarkdown 去掉 next 块,其它组件照常转换", () => {
    const md = uiFencesToMarkdown(`结论。\n\n${SUGG}\n\n${NEXT}`);
    expect(md).not.toContain("next");
    expect(md).not.toContain("把木星的卫星也加上");
    expect(md).toContain("改成可以拖着旋转的三维太阳系");
  });
  test("流式中写到一半的 next 块也不出现", () => {
    expect(uiFencesToMarkdown('结论。\n\n```ui\n{"type":"next","te', true)).not.toContain("next");
  });
});
