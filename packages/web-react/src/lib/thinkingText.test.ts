import { describe, expect, it } from "vitest";
import { sanitizeThinkingText } from "./thinkingText";

describe("sanitizeThinkingText — 思考内容展示清洗", () => {
  it("剥掉上游泄漏的空 HTML 注释(GPT-5.6 reasoning summary 实测形态)", () => {
    expect(sanitizeThinkingText("**Adapting advice for introverted entrepreneur**\n\n<!-- -->")).toBe(
      "**Adapting advice for introverted entrepreneur**",
    );
  });

  it("剥掉带内容的完整注释并收敛遗留空行", () => {
    expect(sanitizeThinkingText("段落一\n\n<!-- sep -->\n\n段落二")).toBe("段落一\n\n段落二");
  });

  it("流式中间态:尾部未闭合注释先行隐藏", () => {
    expect(sanitizeThinkingText("思考中\n\n<!-- 还没流")).toBe("思考中");
  });

  it("普通文本原样保留(含 markdown 星号)", () => {
    expect(sanitizeThinkingText("**标题**\n\n正文 a --> b")).toBe("**标题**\n\n正文 a --> b");
  });
});
