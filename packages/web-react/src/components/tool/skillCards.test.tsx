/**
 * 技能富卡单测:解析器 + 卡片行为断言(render 后查 DOM),失败回退(返回 null → OutputBlock)。
 * 真实会话文本取自 __fixtures__/sessionToolTexts(boss 工具卡演示会话)。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SKILL_LIST_TEXT, SKILL_SEARCH_NO_MATCH_TEXT, SKILL_VIEW_TEXT } from "./__fixtures__/sessionToolTexts";
import { parseSkillList, renderSkillListCard, renderSkillSearchCard, renderSkillViewCard } from "./skillCards";

afterEach(cleanup);

// 服务端 skill_search 命中格式(带 [source: …, score: …] 头 + related_skills/matched 附行)。
const SKILL_SEARCH_MATCH_TEXT = [
  'Found 2 matching skill(s) for "文献":',
  "",
  "### oc-lit [source: platform, score: 5]",
  "文献检索技能:按主题检索论文并返回结构化结果。",
  "tags: literature, search",
  "related_skills: oc-cite",
  "",
  "### my-notes [source: user, score: 3]",
  "我的读书笔记整理技能。",
  "tags: note",
  "",
  "Next: call `skill_view(name)` for the best match before applying it.",
].join("\n");

describe("parseSkillList", () => {
  test("skill_list:分组 + 逐技能(名称/描述/tags/来源),尾部提示行不误入", () => {
    const parsed = parseSkillList(SKILL_LIST_TEXT);
    expect(parsed).not.toBeNull();
    expect(parsed?.declaredCount).toBe(36);
    // 截断 fixture 含 7 个平台技能。
    const names = parsed!.entries.map((e) => e.name);
    expect(names).toContain("browser");
    expect(names).toContain("code-review");
    expect(names).toContain("memory-management");
    const browser = parsed!.entries.find((e) => e.name === "browser")!;
    expect(browser.source).toBe("platform");
    expect(browser.tags).toEqual(["browser", "playwright", "automation", "web"]);
    // 无 tags 行的技能(document-writing)不误吞下一条。
    const doc = parsed!.entries.find((e) => e.name === "document-writing")!;
    expect(doc.tags).toEqual([]);
    expect(doc.description).toMatch(/Pandoc/);
  });

  test("skill_search 命中:头带 [source, score],内联来源生效", () => {
    const parsed = parseSkillList(SKILL_SEARCH_MATCH_TEXT);
    expect(parsed?.entries.map((e) => e.name)).toEqual(["oc-lit", "my-notes"]);
    expect(parsed?.entries[0].source).toBe("platform");
    expect(parsed?.entries[1].source).toBe("user");
  });

  test("非技能列表文本 → null(回退信号)", () => {
    expect(parseSkillList("随便一段没有 skill 头也没有条目的文本")).toBeNull();
    expect(parseSkillList("")).toBeNull();
  });
});

describe("renderSkillListCard", () => {
  test("渲染分组小节 + 技能卡 + tag chips + 来源徽标", () => {
    render(<div>{renderSkillListCard(SKILL_LIST_TEXT)}</div>);
    expect(screen.getByText("共有 36 个技能")).toBeInTheDocument();
    expect(screen.getByText("平台内置技能")).toBeInTheDocument();
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.getByText("debugging")).toBeInTheDocument();
    // tag chip(debugging 独有 tag)。
    expect(screen.getByText("root-cause")).toBeInTheDocument();
    // 平台来源徽标(每卡一个)。
    expect(screen.getAllByText("平台").length).toBeGreaterThanOrEqual(1);
  });

  test("解析失败 → null(调用方回退 OutputBlock)", () => {
    expect(renderSkillListCard("not a skill list")).toBeNull();
  });
});

describe("renderSkillSearchCard", () => {
  test("命中列表:同款技能卡 + 找到 N 个相关技能", () => {
    render(<div>{renderSkillSearchCard(SKILL_SEARCH_MATCH_TEXT, "文献")}</div>);
    expect(screen.getByText("找到 2 个相关技能")).toBeInTheDocument();
    expect(screen.getByText("oc-lit")).toBeInTheDocument();
    expect(screen.getByText("my-notes")).toBeInTheDocument();
  });

  test("无命中 → 友好空态(显示 query,不贴服务端英文提示)", () => {
    render(<div>{renderSkillSearchCard(SKILL_SEARCH_NO_MATCH_TEXT, "平台能力")}</div>);
    expect(screen.getByText("没有找到匹配技能")).toBeInTheDocument();
    expect(screen.getByText("关键词:平台能力")).toBeInTheDocument();
    expect(screen.queryByText(/No matching skills found/)).toBeNull();
  });

  test("解析失败(非空非命中)→ null", () => {
    expect(renderSkillSearchCard("garbage without skill headers", "x")).toBeNull();
  });
});

describe("renderSkillViewCard", () => {
  test("头卡(名称/描述/版本/来源/tags)+ 正文折叠区", () => {
    render(<div>{renderSkillViewCard(SKILL_VIEW_TEXT)}</div>);
    expect(screen.getByText("platform-capabilities")).toBeInTheDocument();
    expect(screen.getByText("v2.1.0")).toBeInTheDocument();
    expect(screen.getByText("平台")).toBeInTheDocument();
    expect(screen.getByText("canvas")).toBeInTheDocument();
    expect(screen.getByText("查看技能正文")).toBeInTheDocument();
  });

  test("skill not found 之类错误文本 → null(回退 OutputBlock)", () => {
    expect(renderSkillViewCard("error: skill not found")).toBeNull();
    expect(renderSkillViewCard("")).toBeNull();
  });
});
