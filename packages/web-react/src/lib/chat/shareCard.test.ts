import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import {
  layoutShareCard,
  type Measure,
  parseShareBlocks,
  SHARE_MAX_LINES_PER_MESSAGE,
  selectShareMessages,
  shareImageFilename,
  shareText,
  stripInline,
  wrapText,
} from "./shareCard";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { text: "", ts: 1, ...partial };
}

// 每个字符 10px:CJK 与拉丁同宽,便于算换行。
const measure: Measure = (text) => [...text].length * 10;

const ids = (list: ChatMessage[]) => list.map((m) => m.id);

describe("selectShareMessages", () => {
  test("只收提问和每轮最终回答:中间叙述、工具、thinking 不进分享物", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "帮我整理客户名单" }),
      msg({ id: "a1", role: "assistant", text: "正在读取 /私有目录/客户名单", _clientMessageId: "u1" }),
      msg({ id: "t1", role: "tool", text: "Read", _clientMessageId: "u1" }),
      msg({ id: "k1", role: "thinking", text: "想一想", _clientMessageId: "u1" }),
      msg({ id: "a2", role: "assistant", text: "整理好了，共 12 位客户。", _clientMessageId: "u1" }),
    ];
    expect(ids(selectShareMessages(list, "all"))).toEqual(["u1", "a2"]);
  });

  test("没有 _clientMessageId 的旧行按用户边界取每轮最后一条正文", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "问" }),
      msg({ id: "a1", role: "assistant", text: "过程" }),
      msg({ id: "t1", role: "tool", text: "Bash" }),
      msg({ id: "a2", role: "assistant", text: "答" }),
    ];
    expect(ids(selectShareMessages(list, "all"))).toEqual(["u1", "a2"]);
  });

  test("恢复控制行不成为轮边界,「最近一轮」仍从真实提问开始;错误卡不收", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "第一问" }),
      msg({ id: "a1", role: "assistant", text: "第一答", _clientMessageId: "u1" }),
      msg({ id: "u2", role: "user", text: "第二问" }),
      msg({ id: "e1", role: "assistant", text: "模型暂不可用", _errorCode: "upstream", _clientMessageId: "u2" }),
      msg({ id: "r1", role: "user", text: "↻ 自动重试", _recoveryMode: "replay", _isAutoRetry: true }),
      msg({ id: "a2", role: "assistant", text: "第二答", _clientMessageId: "u2" }),
    ];
    expect(ids(selectShareMessages(list, "last"))).toEqual(["u2", "a2"]);
    expect(ids(selectShareMessages(list, "all"))).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("恢复子轮带不同 _clientMessageId 时归并回原提问,只收最终答案(r2 复现)", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "整理客户名单" }),
      msg({ id: "a1", role: "assistant", text: "正在读取 /私有目录/客户名单", _clientMessageId: "u1" }),
      msg({ id: "t1", role: "tool", text: "Read", _clientMessageId: "u1" }),
      msg({ id: "e1", role: "assistant", text: "连接中断", _errorCode: "stream_cut", _clientMessageId: "u1" }),
      msg({ id: "r1", role: "user", text: "↻ 自动从断点继续", _recoveryOfClientMessageId: "u1", _recoveryMode: "checkpoint" }),
      msg({ id: "a2", role: "assistant", text: "整理好了。", _clientMessageId: "r1" }),
    ];
    const picked = selectShareMessages(list, "last");
    expect(ids(picked)).toEqual(["u1", "a2"]);
    expect(picked.map((m) => m.text).join("\n")).not.toContain("/私有目录");
  });

  test("生成中:进行中那一轮的回答不收", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "第一问" }),
      msg({ id: "a1", role: "assistant", text: "第一答", _clientMessageId: "u1" }),
      msg({ id: "u2", role: "user", text: "第二问" }),
      msg({ id: "a2", role: "assistant", text: "我先看一下", _clientMessageId: "u2" }),
    ];
    expect(ids(selectShareMessages(list, "last", true))).toEqual(["u2"]);
    expect(ids(selectShareMessages(list, "all", true))).toEqual(["u1", "a1", "u2"]);
    expect(ids(selectShareMessages(list, "last", false))).toEqual(["u2", "a2"]);
  });

  test("排队中、空正文的用户消息不收;范围按真实提问切", () => {
    const list = [
      msg({ id: "u1", role: "user", text: "1" }),
      msg({ id: "a1", role: "assistant", text: "一" }),
      msg({ id: "u2", role: "user", text: "2" }),
      msg({ id: "a2", role: "assistant", text: "二" }),
      msg({ id: "u3", role: "user", text: "3" }),
      msg({ id: "a3", role: "assistant", text: "三" }),
      msg({ id: "u4", role: "user", text: "4" }),
      msg({ id: "a4", role: "assistant", text: "四" }),
      msg({ id: "q", role: "user", text: "排队", status: "queued" }),
      msg({ id: "blank", role: "user", text: "  " }),
    ];
    expect(ids(selectShareMessages(list, "last"))).toEqual(["u4", "a4"]);
    expect(ids(selectShareMessages(list, "last3"))).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"]);
    expect(selectShareMessages(list, "all")).toHaveLength(8);
  });

  test("空会话返回空", () => {
    expect(selectShareMessages([], "last")).toEqual([]);
  });
});

describe("parseShareBlocks", () => {
  test("Markdown 子集转块,行内标记去掉", () => {
    const md = [
      "## 标题 **粗**",
      "",
      "第一段 [链接](https://x.y) 和 `code`",
      "第二行",
      "",
      "- 苹果",
      "- [x] 已办",
      "2. 第二步",
      "> 引用",
      "",
      "```ts",
      "const a = 1",
      "```",
      "```mermaid",
      "graph TD",
      "```",
      "| 列1 | 列2 |",
      "| --- | --- |",
      "| a | b |",
      "---",
      "![猫](https://img)",
    ].join("\n");
    expect(parseShareBlocks(md)).toEqual([
      { kind: "heading", text: "标题 粗" },
      { kind: "para", text: "第一段 链接 和 code\n第二行" },
      { kind: "item", marker: "•", text: "苹果" },
      { kind: "item", marker: "☑", text: "已办" },
      { kind: "item", marker: "2.", text: "第二步" },
      { kind: "quote", text: "引用" },
      { kind: "code", text: "const a = 1" },
      { kind: "para", text: "[图表]" },
      { kind: "row", cells: ["列1", "列2"], header: true },
      { kind: "row", cells: ["a", "b"], header: false },
      { kind: "rule" },
      { kind: "para", text: "[图片:猫]" },
    ]);
  });

  test("stripInline 处理 <br>、删除线、无 alt 图片", () => {
    expect(stripInline("a<br/>b ~~c~~ ![](u)")).toBe("a\nb c [图片]");
  });
});

describe("wrapText", () => {
  test("中文逐字换行", () => {
    expect(wrapText("一二三四五六七", 30, "", measure)).toEqual(["一二三", "四五六", "七"]);
  });

  test("英文按词换行,不拆单词", () => {
    expect(wrapText("hello world foo", 60, "", measure)).toEqual(["hello", "world", "foo"]);
  });

  test("句读不放行首,挂在上一行", () => {
    expect(wrapText("一二三，四", 30, "", measure)).toEqual(["一二三，", "四"]);
  });

  test("超长串按字符硬断;保留空行", () => {
    expect(wrapText("abcdefgh\n\nx", 30, "", measure)).toEqual(["abc", "def", "gh", "", "x"]);
  });
});

describe("layoutShareCard", () => {
  const base = { title: "周末安排", agentName: "全能助手", now: new Date(2026, 9, 10) };

  test("页眉含品牌、标题、日期与轮数;正文与页脚都画出来", () => {
    const layout = layoutShareCard(
      { ...base, messages: [{ role: "user", text: "周末去哪" }, { role: "assistant", text: "去青城山。" }] },
      measure,
    );
    const texts = layout.ops.flatMap((o) => (o.t === "text" ? [o.text] : []));
    expect(texts).toContain("从简 · Clarvy");
    expect(texts).toContain("周末安排");
    expect(texts.some((t) => t.startsWith("2026-10-10 · 1 轮对话"))).toBe(true);
    expect(texts).toContain("周末去哪");
    expect(texts).toContain("去青城山。");
    expect(texts).toContain("由 从简 Clarvy 生成");
    expect(texts.every((t) => !t.includes("\u0000"))).toBe(true);
    expect(layout.omitted).toBe(0);
    expect(layout.ops[0]).toMatchObject({ t: "rect", h: layout.height });
  });

  test("表格放得下时画成网格(每格单独一段文字),放不下退回逐行文字", () => {
    const table = "| 人数 | 牛肉 |\n| --- | --- |\n| 4 人 | 400g |";
    const grid = layoutShareCard({ ...base, messages: [{ role: "assistant", text: table }] }, measure);
    const gridTexts = grid.ops.flatMap((o) => (o.t === "text" ? [o.text] : []));
    expect(gridTexts).toEqual(expect.arrayContaining(["人数", "牛肉", "4 人", "400g"]));
    const wide = `| ${"很长的列".repeat(20)} | b |\n| --- | --- |\n| x | y |`;
    const flat = layoutShareCard({ ...base, messages: [{ role: "assistant", text: wide }] }, measure);
    const flatTexts = flat.ops.flatMap((o) => (o.t === "text" ? [o.text] : []));
    expect(flatTexts).toContain("x  ·  y");
  });

  test("代码块的底色块完整落在助手卡片内(留白计入高度)", () => {
    const layout = layoutShareCard({ ...base, messages: [{ role: "assistant", text: "```\nconst a = 1\n```" }] }, measure);
    const rects = layout.ops.filter((o): o is Extract<typeof o, { t: "rect" }> => o.t === "rect");
    const card = rects.find((r) => r.stroke && r.w > 400);
    const code = rects.find((r) => r.fill === "#f3f3f6");
    expect(card && code).toBeTruthy();
    if (!card || !code) return;
    expect(code.y + code.h).toBeLessThanOrEqual(card.y + card.h - 16);
  });

  test("单条消息超过行数上限时截断并标注", () => {
    const long = Array.from({ length: SHARE_MAX_LINES_PER_MESSAGE + 20 }, (_, i) => `第${i}行`).join("\n");
    const layout = layoutShareCard({ ...base, messages: [{ role: "assistant", text: long }] }, measure);
    const texts = layout.ops.flatMap((o) => (o.t === "text" ? [o.text] : []));
    expect(texts).toContain("……(内容较长，已截断)");
    expect(texts).not.toContain(`第${SHARE_MAX_LINES_PER_MESSAGE + 5}行`);
  });

  test("超出高度上限时保留最新消息并标注省略条数", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      text: `消息${i}\n`.repeat(6),
    }));
    const layout = layoutShareCard({ ...base, messages }, measure, 1500);
    const texts = layout.ops.flatMap((o) => (o.t === "text" ? [o.text] : []));
    expect(layout.omitted).toBeGreaterThan(0);
    expect(layout.height).toBeLessThanOrEqual(1500);
    expect(texts).toContain(`前面 ${layout.omitted} 条消息未包含`);
    expect(texts).toContain("消息29");
    expect(texts).not.toContain("消息0");
  });
});

describe("shareText / shareImageFilename", () => {
  test("文字版:标题、说话人、纯文本正文、来源", () => {
    const text = shareText("周末", "全能助手", [
      { role: "user", text: "去哪" },
      { role: "assistant", text: "## 方案\n- **青城山**\n| 天 | 事 |\n|---|---|\n| 六 | 爬山 |" },
    ]);
    expect(text).toBe("【周末】\n\n我：\n去哪\n\n全能助手：\n方案\n• 青城山\n天 | 事\n六 | 爬山\n\n—— 来自「从简 Clarvy」");
  });

  test("文件名沿用导出规则", () => {
    expect(shareImageFilename(null)).toBe("新对话.png");
    expect(shareImageFilename("a/b")).toBe("a_b.png");
  });
});
