import { describe, expect, it } from "vitest";
import {
  THINKING_HEADLINES_ONLY,
  THINKING_MULTI_SEGMENT,
} from "../components/tool/__fixtures__/sessionToolTexts";
import {
  firstBoldHeadline,
  sanitizeThinkingText,
  thinkingSegments,
  thinkingSummaryTitle,
} from "./thinkingText";

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

describe("thinkingSegments — 多段清洗(合并卡输入)", () => {
  it("逐条 sanitize + 丢弃空段(仅注释/空白的段)", () => {
    expect(thinkingSegments(["<!-- -->", "   \n ", "**Title**\n\n<!-- -->", undefined])).toEqual([
      "**Title**",
    ]);
  });

  it("真实 codex 摘要(单条含多标题)清洗成一段多标题正文", () => {
    // THINKING_HEADLINES_ONLY 是一条消息内含 3 个 `**标题**` + `<!-- -->` 分隔;剥注释后合成一段。
    expect(thinkingSegments([THINKING_HEADLINES_ONLY])).toEqual([
      "**Planning tool usage strategy**\n\n**Planning multi-tool demonstration**\n\n**Planning explicit collaboration spawn**",
    ]);
  });

  it("多条 thinking 消息 → 多段", () => {
    expect(thinkingSegments([THINKING_HEADLINES_ONLY, THINKING_MULTI_SEGMENT])).toHaveLength(2);
  });
});

describe("firstBoldHeadline / thinkingSummaryTitle — 折叠态摘要", () => {
  it("取首个粗体标题并剥星号", () => {
    expect(firstBoldHeadline("**Planning tool usage strategy**\n\n**second**")).toBe(
      "Planning tool usage strategy",
    );
  });

  it("无粗体 → null(卡片维持「已思考」原状)", () => {
    expect(firstBoldHeadline("推理中...")).toBeNull();
    expect(thinkingSummaryTitle(["纯文本段", "另一段"])).toBeNull();
  });

  it("摘要取最新(末)段的首个粗体标题", () => {
    const segs = thinkingSegments([THINKING_HEADLINES_ONLY, THINKING_MULTI_SEGMENT]);
    expect(thinkingSummaryTitle(segs)).toBe("Creating generated tool-card-demo.txt file");
  });

  it("末段无标题时优雅回退到更早的段", () => {
    expect(thinkingSummaryTitle(["**Earlier headline**", "纯文本收尾无标题"])).toBe(
      "Earlier headline",
    );
  });
});
