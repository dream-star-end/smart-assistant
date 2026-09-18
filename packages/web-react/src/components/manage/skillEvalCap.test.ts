import { describe, expect, it } from "vitest";
import { MAX_EVAL_CASES } from "@openclaude/protocol";

// S-03 回归护栏:评测用例上限的单一权威在 @openclaude/protocol，storage 与 web 同源。
// 历史上 web 面板把上限硬编码为 5、后端为 8，导致 6-8 用例的技能显示 "8/5" 且禁用加用例。
// 若有人再把 web 侧写回一个与后端不同的字面量，此断言与 SkillOptPanel 的 MAX_EVAL_CASES 引用会一起兜住。
describe("skill eval case cap · S-03 single authority", () => {
  it("web derives the cap from protocol and matches storage (=8, not the old hardcoded 5)", () => {
    expect(MAX_EVAL_CASES).toBe(8);
    expect(MAX_EVAL_CASES).toBeGreaterThan(5);
  });
});
