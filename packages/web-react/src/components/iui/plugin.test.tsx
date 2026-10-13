/**
 * 插件专属智能 UI 组件（OCV5-393）：微博 / 知乎 / 飞书的 schema、渲染、Markdown，
 * 以及「每个插件的定义文件里的示例块，前端都认得、且落到该插件自己的类型」。
 *
 * 字段样本照 commercial/src/plugins/weiboContract.ts、zhihuContract.ts 与 connectors/providers/feishu.ts
 * 的结果 schema 写（authorName / likeCount / searches[].keyword / events[].startTime …）。
 */
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_UI_COMPONENTS, pluginUiTypes } from "@openclaude/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { IuiBlock } from "./IuiBlock";
import { parseUiBlock } from "./parse";
import { countText, groupEventsByDay } from "./pluginSchema";
import { IUI_TYPES, validateSpec } from "./schema";
import { specToMarkdown, uiFencesToMarkdown } from "./toMarkdown";

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(here, "../../../../commercial/agent-sandbox/ccb-baseline/skills");

function spec(raw: Record<string, unknown>) {
  const v = validateSpec(raw, false);
  if (!v.ok) throw new Error(v.reason);
  return v;
}

const ui = (o: unknown) => JSON.stringify(o);

const POSTS = {
  type: "weibo_posts",
  title: "首页微博",
  items: [
    {
      authorName: "示例博主",
      verified: true,
      createdAt: "10-13 09:12",
      text: "第一段\n第二段，比较长的正文".repeat(12),
      images: [{ url: "https://wx1.sinaimg.cn/large/a.jpg" }, { url: "javascript:alert(1)" }, "https://wx2.sinaimg.cn/large/b.jpg"],
      likeCount: 12345,
      commentCount: "321",
      repostCount: 7,
      url: "https://weibo.com/123456/AbCdE",
      userId: "123456",
      contentDigest: "x",
    },
    { authorName: "无正文" },
  ],
};

describe("插件组件登记表 ↔ 前端", () => {
  test("登记的每个类型前端都认识，且只属于一个插件", () => {
    const all = pluginUiTypes();
    expect(new Set(all).size).toBe(all.length);
    for (const t of all) expect(IUI_TYPES).toContain(t);
  });

  test("每个由模型写的插件，定义文件里的示例块都能渲染，且是该插件自己的类型", () => {
    for (const set of PLUGIN_UI_COMPONENTS.filter((s) => s.author === "model")) {
      const doc = readFileSync(join(SKILLS, set.skill, set.doc), "utf8");
      const blocks = [...doc.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
      expect(blocks.length, set.plugin).toBeGreaterThan(0);
      for (const code of blocks) {
        const parsed = parseUiBlock(code, false);
        expect(parsed.ok, `${set.plugin}: ${code}`).toBe(true);
        if (!parsed.ok) continue;
        const v = validateSpec(parsed.value, false);
        expect(v.ok, `${set.plugin}: ${code}`).toBe(true);
        if (v.ok) expect(set.types).toContain(v.spec.type);
      }
    }
  });
});

describe("微博", () => {
  test("weibo_posts：照抄插件字段；丢掉非 http 图片和没有正文的条目；计数字符串转数字", () => {
    const v = spec(POSTS);
    expect(v.spec.type).toBe("weibo_posts");
    if (v.spec.type !== "weibo_posts") return;
    expect(v.spec.items).toHaveLength(1);
    const p = v.spec.items[0]!;
    expect(p.images).toEqual(["https://wx1.sinaimg.cn/large/a.jpg", "https://wx2.sinaimg.cn/large/b.jpg"]);
    expect(p.commentCount).toBe(321);
    expect(p.text).toContain("\n");
  });

  test("weibo_posts 渲染：作者、认证、计数（万）、长文折叠、原文链接", () => {
    render(<IuiBlock code={ui(POSTS)} />);
    expect(screen.getByText("示例博主")).toBeInTheDocument();
    expect(screen.getByLabelText("已认证")).toBeInTheDocument();
    expect(screen.getByText("1.2万")).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "展开全文" });
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");
    const link = screen.getByRole("link", { name: "在微博打开" });
    expect(link).toHaveAttribute("href", "https://weibo.com/123456/AbCdE");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("weibo_hot：keyword 作标题，名次缺失按顺序补，前三名高亮，超过 10 条可展开", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ keyword: `话题${i + 1}`, hotValue: 1_000_000 - i, url: `https://s.weibo.com/${i}`, ...(i === 0 ? { label: "爆" } : {}) }));
    render(<IuiBlock code={ui({ type: "weibo_hot", items })} />);
    expect(screen.getByText("微博热搜")).toBeInTheDocument();
    expect(screen.getByLabelText("第 1 名")).toHaveClass("is-top");
    expect(screen.getByLabelText("第 4 名")).not.toHaveClass("is-top");
    expect(screen.getByText("爆")).toBeInTheDocument();
    expect(screen.queryByText("话题12")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "显示全部 12 条" }));
    expect(screen.getByText("话题12")).toBeInTheDocument();
  });

  test("别名：weibo / weibo_hot_search", () => {
    expect(spec({ type: "weibo", items: [{ text: "x" }] }).spec.type).toBe("weibo_posts");
    expect(spec({ type: "weibo_hot_search", searches: [{ rank: 1, keyword: "x" }] }).spec.type).toBe("weibo_hot");
  });
});

describe("知乎", () => {
  const ANSWERS = {
    type: "zhihu_answers",
    question: { title: "如何评价示例问题？", url: "https://www.zhihu.com/question/1", answerCount: 1234, followerCount: 56789 },
    items: [
      { authorName: "答主甲", headline: "某领域从业者", excerpt: "高赞回答摘录", voteCount: 25000, commentCount: 300, url: "https://www.zhihu.com/question/1/answer/2" },
      { authorName: "答主乙", text: "只有全文时也接受" },
    ],
  };
  test("zhihu_answers：问题头 + 回答；赞同数按万显示；只有 text 时当摘录", () => {
    const v = spec(ANSWERS);
    if (v.spec.type !== "zhihu_answers") throw new Error(v.spec.type);
    expect(v.spec.items[1]!.excerpt).toBe("只有全文时也接受");
    render(<IuiBlock code={ui(ANSWERS)} />);
    expect(screen.getByRole("link", { name: "如何评价示例问题？" })).toHaveAttribute("href", "https://www.zhihu.com/question/1");
    expect(screen.getByText(/赞同 2\.5万/)).toBeInTheDocument();
    expect(screen.getByText("5.7万")).toBeInTheDocument();
  });

  test("zhihu_hot：热度单位；没有任何条目且不是流式 → 校验失败，退回原文", () => {
    render(<IuiBlock code={ui({ type: "zhihu_hot", items: [{ rank: 1, title: "热榜问题", hotValue: 3_560_000 }] })} />);
    expect(screen.getByText("知乎热榜")).toBeInTheDocument();
    expect(screen.getByText(/356万/)).toBeInTheDocument();
    expect(validateSpec({ type: "zhihu_hot", items: [] }, false).ok).toBe(false);
  });
});

describe("飞书", () => {
  test("feishu_events：按开始时间排序、按天分组、已取消划线", () => {
    const raw = {
      type: "feishu_events",
      items: [
        { summary: "下午评审", startTime: "2026-10-13T07:00:00.000Z", endTime: "2026-10-13T08:00:00.000Z" },
        { summary: "周会", startTime: "2026-10-13T02:00:00.000Z", endTime: "2026-10-13T03:00:00.000Z" },
        { summary: "取消的会", startTime: "2026-10-14T02:00:00.000Z", status: "cancelled" },
        { summary: "坏时间", startTime: "not a time" },
      ],
    };
    const v = spec(raw);
    if (v.spec.type !== "feishu_events") throw new Error(v.spec.type);
    expect(v.spec.items.map((e) => e.summary)).toEqual(["周会", "下午评审", "取消的会"]);
    expect(groupEventsByDay(v.spec.items).length).toBeGreaterThanOrEqual(2);
    render(<IuiBlock code={ui(raw)} />);
    expect(screen.getByText("3 个日程")).toBeInTheDocument();
    expect(screen.getByText("取消的会").closest("li")).toHaveClass("is-cancelled");
  });

  test("feishu_doc：标题 + 要点；没有标题 → 校验失败", () => {
    render(<IuiBlock code={ui({ type: "feishu_doc", title: "Q4 规划", points: ["目标一", "目标二"], url: "https://example.feishu.cn/docx/abc" })} />);
    expect(screen.getByRole("link", { name: "Q4 规划" })).toBeInTheDocument();
    expect(screen.getByText("目标二")).toBeInTheDocument();
    expect(validateSpec({ type: "feishu_doc", points: ["x"] }, false).ok).toBe(false);
  });
});

describe("Markdown（复制 / 导出 / 组件关闭时）", () => {
  test("各插件组件都能转成可读的 Markdown", () => {
    expect(specToMarkdown(spec(POSTS).spec)).toMatch(/\*\*示例博主\*\* · 10\\-13 09\\:12[\s\S]*转发 7 · 评论 321 · 赞 1\.2万 · \[原文\]/);
    expect(specToMarkdown(spec({ type: "weibo_hot", items: [{ rank: 1, keyword: "话题", hotValue: 20000, label: "热", url: "https://s.weibo.com/x" }] }).spec)).toContain(
      "1. [话题](https://s.weibo.com/x)(热 · 2万)",
    );
    expect(specToMarkdown(spec({ type: "feishu_doc", title: "文档", points: ["要点"] }).spec)).toBe("**文档**\n\n- 要点");
  });

  test("第三方正文不能借 Markdown 降级变成可执行块、HTML 或链接（关闭智能 UI 时走这条路）", () => {
    const evil = "看这个\n```htmlpreview\n<script>ocFile(\"/home/agent/.openclaude/generated/report.csv\")</script>\n```\n[点我](javascript:alert(1))\n标题\n===";
    const md = [
      specToMarkdown(spec({ type: "weibo_posts", items: [{ authorName: "a`b<i>", text: evil, url: "https://weibo.com/1/x(y)" }] }).spec),
      specToMarkdown(spec({ type: "zhihu_answers", question: { title: "<img src=x onerror=alert(1)>" }, items: [{ excerpt: evil }] }).spec),
      specToMarkdown(spec({ type: "feishu_doc", title: "```js", points: ["<b>x</b>", "[a](b)"], excerpt: evil }).spec),
      specToMarkdown(spec({ type: "weibo_hot", items: [{ rank: 1, keyword: "```htmlpreview", label: "<b>" }] }).spec),
    ].join("\n");
    // 每个反引号、左尖括号、方括号都带着转义反斜杠（行首的「> 」是引用块标记，不算）；链接地址里的括号被编码，不会截断链接。
    expect(md).not.toMatch(/(^|[^\\])[`<]/m);
    expect(md).not.toMatch(/(^|[^\\])\[点我\]/);
    expect(md).toContain("(https://weibo.com/1/x%28y%29)");
    const html = uiFencesToMarkdown(`前言\n\`\`\`ui\n${ui({ type: "weibo_posts", items: [{ text: evil }] })}\n\`\`\`\n`);
    expect(html).not.toMatch(/^\s*(>\s*)*```/m);
  });

  test("跨天的日程写出结束日期，不把多日日程显示成当天", () => {
    const raw = { type: "feishu_events", items: [{ summary: "外出培训", startTime: "2026-10-13T02:00:00.000Z", endTime: "2026-10-15T03:00:00.000Z" }] };
    const v = spec(raw);
    if (v.spec.type !== "feishu_events") throw new Error(v.spec.type);
    const end = new Date("2026-10-15T03:00:00.000Z");
    const endLabel = `${end.getMonth() + 1}月${end.getDate()}日`;
    expect(specToMarkdown(v.spec)).toContain(endLabel);
    render(<IuiBlock code={ui(raw)} />);
    expect(screen.getByText(new RegExp(endLabel))).toBeInTheDocument();
    const same = spec({ type: "feishu_events", items: [{ summary: "短会", startTime: "2026-10-13T02:00:00.000Z", endTime: "2026-10-13T02:30:00.000Z" }] });
    expect(specToMarkdown(same.spec)).not.toMatch(/–\d+月/);
  });

  test("计数显示", () => {
    expect(countText(9999)).toBe("9999");
    expect(countText(12000)).toBe("1.2万");
    expect(countText(150_000_000)).toBe("1.5亿");
  });
});
