import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIntelligentUiForTests } from "../../lib/intelligentUi";
import { IuiBlock } from "./IuiBlock";
import { LONG_TABLE_ROWS, rowMatches } from "./TableBlock";
import { countWords, diffText, tokenize } from "./diff";
import { type TableSpec, validateSpec } from "./schema";
import { specToMarkdown, tableToCsv, uiFencesToMarkdown } from "./toMarkdown";

const j = (v: unknown) => JSON.stringify(v);
const ok = (raw: Record<string, unknown>) => {
  const v = validateSpec(raw, false);
  if (!v.ok) throw new Error(`expected ok, got ${v.reason}`);
  return v;
};

beforeEach(() => {
  __resetIntelligentUiForTests();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(cleanup);

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

describe("schema · round 3", () => {
  it("sources keep http(s) links only, derive the site, fall back to it as the title", () => {
    const v = ok({
      type: "references",
      items: [
        { title: "国家统计局:2025 年居民收入", url: "https://www.stats.gov.cn/sj/2026/01.html", date: "2026-01-17", note: "人均可支配收入 4.3 万元" },
        { url: "https://example.org/report" },
        { title: "坏链接", url: "javascript:alert(1)" },
        { title: "纸质书", site: "人民出版社" },
        { note: "没有标题也没有链接" },
      ],
    });
    expect(v.spec.type).toBe("sources");
    if (v.spec.type !== "sources") throw new Error("sources");
    expect(v.spec.items).toHaveLength(4);
    expect(v.spec.items[0]).toMatchObject({ site: "stats.gov.cn", date: "2026-01-17" });
    expect(v.spec.items[1]).toMatchObject({ title: "example.org", url: "https://example.org/report" });
    expect(v.spec.items[2]!.url).toBeUndefined();
    expect(v.spec.items[3]).toMatchObject({ title: "纸质书", site: "人民出版社" });
  });

  it("outline accepts strings and nested objects, caps depth and node count with a note", () => {
    const deep = { title: "1", children: [{ title: "2", children: [{ title: "3", children: [{ title: "4", children: [{ title: "5" }] }] }] }] };
    const v = ok({ type: "mindmap", view: "mind_map", items: [deep, "独立要点"] });
    if (v.spec.type !== "outline") throw new Error("outline");
    expect(v.spec.view).toBe("map");
    expect(v.spec.items[1]).toEqual({ title: "独立要点", children: [] });
    const level4 = v.spec.items[0]!.children[0]!.children[0]!.children[0]!;
    expect(level4.title).toBe("4");
    expect(level4.children).toEqual([]);
    expect(v.notes.join()).toContain("最多 4 层");

    const many = ok({ type: "outline", items: Array.from({ length: 30 }, (_, i) => ({ title: `章 ${i}`, children: ["a", "b", "c"] })) });
    if (many.spec.type !== "outline") throw new Error("outline");
    const total = many.spec.items.reduce((n, x) => n + 1 + x.children.length, 0);
    expect(total).toBeLessThanOrEqual(80);
    expect(many.notes.join()).toContain("80 个节点");
    expect(validateSpec({ type: "outline", items: [] }, false).ok).toBe(false);
  });

  it("draft takes variants or a single text, normalises kind aliases, keeps line breaks and caps versions", () => {
    const single = ok({ type: "email", kind: "mail", subject: "周五请假", text: "王经理:\r\n\n  周五想请一天假。\n\n谢谢!\n" });
    if (single.spec.type !== "draft") throw new Error("draft");
    expect(single.spec.kind).toBe("email");
    expect(single.spec.variants).toEqual([{ label: "版本 1", subject: "周五请假", text: "王经理:\n\n  周五想请一天假。\n\n谢谢!" }]);

    const many = ok({ type: "draft", kind: "tweet", variants: ["一", { label: "正式", text: "二" }, { body: "三" }, "四"], original: "原来的" });
    if (many.spec.type !== "draft") throw new Error("draft");
    expect(many.spec.kind).toBeUndefined();
    expect(many.spec.variants.map((x) => x.label)).toEqual(["版本 1", "正式", "版本 3"]);
    expect(many.spec.original).toBe("原来的");
    expect(many.notes.join()).toContain("版本超过 3 项");
    expect(validateSpec({ type: "draft", variants: [{ text: "  " }] }, false).ok).toBe(false);
  });
});

describe("markdown and csv · round 3", () => {
  it("the new components convert to readable Markdown (off mode, copy, export)", () => {
    const blocks = [
      { type: "sources", items: [{ title: "统计公报", url: "https://stats.example.gov/a", date: "2026-02", note: "全年数据" }] },
      { type: "outline", title: "书的结构", items: [{ title: "第一部分", detail: "起源", children: ["第 1 章", { title: "第 2 章", children: ["2.1"] }] }] },
      { type: "draft", kind: "email", variants: [{ label: "正式", subject: "合作邀请", text: "您好:\n想邀请您参加。" }, { label: "轻松", text: "嗨,来玩吗?" }], original: "来参加吧" },
    ];
    const md = uiFencesToMarkdown(blocks.map((b) => `\`\`\`ui\n${j(b)}\n\`\`\``).join("\n\n"));
    expect(md).not.toContain("```");
    for (const needle of [
      "1. [统计公报](https://stats.example.gov/a)(stats.example.gov · 2026-02) —— 全年数据",
      "- **第一部分** —— 起源",
      "  - 第 2 章",
      "    - 2.1",
      "### 正式",
      "**主题**:合作邀请",
      "您好:\n想邀请您参加。",
      "### 轻松",
      "原文:",
      "> 来参加吧",
    ]) {
      expect(md).toContain(needle);
    }
  });

  it("table CSV has a BOM, unit headers, raw numbers, quoting and no formula injection", () => {
    const v = ok({
      type: "table",
      columns: ["城市", { label: "人口", unit: "万" }, "备注"],
      rows: [
        ["上海", 2487.45, '含"常住",不含流动'],
        ["=HYPERLINK(1)", 1200, "两行\n备注"],
        ["北京", null, "@cmd"],
      ],
    });
    const csv = tableToCsv(v.spec as TableSpec);
    expect(csv.startsWith("﻿城市,人口(万),备注\r\n")).toBe(true);
    expect(csv).toContain('上海,2487.45,"含""常住"",不含流动"');
    expect(csv).toContain("'=HYPERLINK(1),1200,\"两行\n备注\"");
    expect(csv).toContain("北京,,'@cmd");
  });
});

describe("diff", () => {
  it("tokenizes Chinese by character and English by word", () => {
    expect(tokenize("我们 meet at 3pm。")).toEqual(["我", "们", " ", "meet", " ", "at", " ", "3pm", "。"]);
    expect(countWords("我们 meet at 3pm。")).toBe(5);
    expect(tokenize("SaaS增长")).toEqual(["SaaS", "增", "长"]);
  });

  it("marks only what changed and reassembles both texts", () => {
    const before = "下周三下午开会,请大家准时参加。Please be on time.";
    const after = "下周四上午开会,请大家提前五分钟到。Please be early.";
    const segs = diffText(before, after)!;
    const rebuild = (keep: "add" | "del") => segs.filter((s) => s.op !== keep).map((s) => s.text).join("");
    expect(rebuild("add")).toBe(before);
    expect(rebuild("del")).toBe(after);
    // 相邻的删改成组显示(先删后增),不拆成单字交错
    expect(segs.filter((s) => s.op === "del").map((s) => s.text)).toEqual(["三下", "准时参加", "on time"]);
    expect(segs.filter((s) => s.op === "add").map((s) => s.text)).toEqual(["四上", "提前五分钟到", "early"]);
    expect(segs.find((s) => s.op === "eq" && s.text.includes("开会,请大家"))).toBeTruthy();
    expect(diffText("一样", "一样")).toEqual([{ op: "eq", text: "一样" }]);
    // 两处改动之间只剩一两个相同的字:并成一块,不碎成单字交错
    expect(diffText("开头甲A乙结尾", "开头丙A丁结尾")).toEqual([
      { op: "eq", text: "开头" },
      { op: "del", text: "甲A乙" },
      { op: "add", text: "丙A丁" },
      { op: "eq", text: "结尾" },
    ]);
  });

  it("falls back to lines when there are too many edits, then gives up", () => {
    const a = Array.from({ length: 40 }, (_, i) => `第${i}行内容${"甲".repeat(i % 7)}`).join("\n");
    const b = Array.from({ length: 40 }, (_, i) => (i % 2 ? `第${i}行内容${"甲".repeat(i % 7)}` : `改写${i}${"乙".repeat(9)}`)).join("\n");
    const byLine = diffText(a, b, 60)!;
    expect(byLine.some((s) => s.op === "eq" && s.text.includes("第1行内容"))).toBe(true);
    expect(byLine.filter((s) => s.op !== "add").map((s) => s.text).join("")).toBe(a);
    const many = (ch: string) => Array.from({ length: 12 }, (_, i) => `${ch}${i}`).join("\n");
    expect(diffText(many("甲"), many("乙"), 5)).toBeNull();
  });
});

describe("render · round 3", () => {
  it("sources number each link, open it in a new tab without a referrer, fold long lists", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ title: `来源 ${i + 1}`, url: `https://s${i}.example.com/p`, date: "2026-10" }));
    items[2] = { title: "内部纪要", url: undefined as unknown as string, date: "2026-09" };
    render(<IuiBlock code={j({ type: "sources", items })} />);
    expect(screen.getByText("参考来源")).toBeInTheDocument();
    const first = screen.getByRole("link", { name: /^1\. 来源 1\W*s0\.example\.com\W*在新标签页打开$/ });
    expect(first).toHaveAttribute("href", "https://s0.example.com/p");
    expect(first).toHaveAttribute("target", "_blank");
    expect(first).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByText("内部纪要").closest("a")).toBeNull();
    // 9 个来源:先显示 5 个,展开看全部
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "显示全部 9 个来源" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
  });

  it("outline expands and collapses branches, can expand everything and switch to a mind map", () => {
    const { container } = render(
      <IuiBlock
        code={j({
          type: "outline",
          title: "《原则》读书笔记",
          items: [
            { title: "生活原则", children: [{ title: "拥抱现实", children: ["痛苦 + 反思 = 进步"] }, "五步流程"] },
            { title: "工作原则", detail: "把公司当机器", children: ["创意择优"] },
          ],
        })}
      />,
    );
    const branch = screen.getByRole("button", { name: /^拥抱现实/ });
    expect(branch).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("痛苦 + 反思 = 进步")).toBeInTheDocument();
    fireEvent.click(branch);
    expect(branch).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("痛苦 + 反思 = 进步")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.queryByText("五步流程")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.getByText("痛苦 + 反思 = 进步")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "导图" }));
    expect(container.querySelector(".oc-iui-mind-root")).toHaveTextContent("《原则》读书笔记");
    const map = within(container.querySelector(".oc-iui-mind-branches") as HTMLElement);
    expect(map.getByRole("region", { name: "生活原则" })).toHaveTextContent("拥抱现实痛苦 + 反思 = 进步");
    expect(map.getByRole("region", { name: "工作原则" })).toHaveTextContent("把公司当机器");
  });

  it("big outlines start with the third level folded; flat outlines offer no mind map", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ title: `章 ${i}`, children: [{ title: `节 ${i}`, children: ["要点甲", "要点乙", "要点丙"] }] }));
    render(<IuiBlock code={j({ type: "outline", items })} />);
    expect(screen.getAllByRole("button", { name: /^节 / })[0]).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("要点甲")).toBeNull();
    cleanup();
    render(<IuiBlock code={j({ type: "outline", view: "map", items: ["一", "二", "三"] })} />);
    expect(screen.queryByRole("radio", { name: "导图" })).toBeNull();
    expect(screen.getByText("二")).toBeInTheDocument();
  });

  it("draft copies the plain text of the chosen version, its subject, and shows the edits against the original", async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <IuiBlock
        code={j({
          type: "draft",
          title: "请假邮件",
          kind: "email",
          variants: [
            { label: "正式", subject: "周五请假一天", text: "王经理:\n\n我想周五请假一天,处理家里的事。\n\n谢谢!" },
            { label: "简短", subject: "周五请假", text: "王经理,周五请一天假,谢谢!" },
          ],
          original: "王经理,我周五不来了。",
        })}
      />,
    );
    expect(screen.getByText("邮件")).toBeInTheDocument();
    expect(container.querySelector(".oc-iui-draft-text")!.textContent).toBe("王经理:\n\n我想周五请假一天,处理家里的事。\n\n谢谢!");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    });
    expect(writeText).toHaveBeenLastCalledWith("王经理:\n\n我想周五请假一天,处理家里的事。\n\n谢谢!");

    fireEvent.click(screen.getByRole("radio", { name: "简短" }));
    expect(screen.getByText("周五请假")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制主题" }));
    });
    expect(writeText).toHaveBeenLastCalledWith("周五请假");

    const toggle = screen.getByRole("button", { name: "对比原文" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelectorAll(".oc-iui-diff ins").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".oc-iui-diff del").length).toBeGreaterThan(0);
    expect(screen.getByText(/^删 \d+ 字$/)).toBeInTheDocument();
  });

  it("long drafts are never truncated, and a diff that gives up still shows the full text (review r1)", async () => {
    const writeText = mockClipboard();
    const text = `${"a".repeat(6000)}新条款`;
    const v = ok({ type: "draft", variants: [{ text }], original: `${"a".repeat(6000)}旧条款` });
    if (v.spec.type !== "draft") throw new Error("draft");
    expect(v.spec.variants[0]!.text).toBe(text);
    expect(specToMarkdown(v.spec)).toContain("新条款");
    expect(diffText(v.spec.original!, text)!.filter((s) => s.op !== "eq").map((s) => s.text)).toEqual(["旧", "新"]);
    const { container } = render(<IuiBlock code={j({ type: "draft", variants: [{ text }] })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    });
    expect(writeText).toHaveBeenLastCalledWith(text);
    cleanup();

    const lines = (ch: string) => Array.from({ length: 601 }, () => ch).join("\n");
    const r = render(<IuiBlock code={j({ type: "draft", variants: [{ text: lines("乙") }], original: lines("甲") })} />);
    fireEvent.click(screen.getByRole("button", { name: "对比原文" }));
    expect(screen.getByText(/改动太多/)).toBeInTheDocument();
    expect(r.container.querySelector(".oc-iui-draft-text")!.textContent).toBe(lines("乙"));
    expect(container).toBeTruthy();
  });

  it("a streaming draft shows its text as it arrives but cannot be copied yet", () => {
    render(<IuiBlock live code={'{"type":"draft","variants":[{"text":"各位家长好,本周五'} />);
    expect(screen.getByText("各位家长好,本周五")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制全文" })).toBeDisabled();
  });

  it("long tables get a filter, a sticky scrolling body and a CSV download of the visible rows", async () => {
    const rows = Array.from({ length: LONG_TABLE_ROWS + 8 }, (_, i) => [`城市${i}`, i % 3 === 0 ? "华东" : "华北", 100 + i]);
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return "blob:x";
      },
      revokeObjectURL: () => undefined,
    });
    const readBlob = (b: Blob) =>
      new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.readAsText(b);
      });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container } = render(<IuiBlock code={j({ type: "table", title: "城市", columns: ["城市", "区域", "指数"], rows })} />);
    expect(container.querySelector(".oc-iui-table-region.is-long")).not.toBeNull();
    const input = screen.getByRole("searchbox", { name: "筛选表格行" });
    fireEvent.change(input, { target: { value: "华东" } });
    expect(screen.getByText(`7 / ${rows.length} 行`)).toBeInTheDocument();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "下载筛选后的 7 行为 CSV" }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const csv = await readBlob(blobs[0]!);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(8);
    expect(csv).toContain("城市3,华东,103");
    fireEvent.change(input, { target: { value: "火星" } });
    expect(screen.getByText("没有包含「火星」的行")).toBeInTheDocument();
    click.mockRestore();
  });

  it("short untitled tables stay as they were: no filter, no download button", () => {
    const { container } = render(<IuiBlock code={j({ type: "table", columns: ["a", "b"], rows: [["1", "2"]] })} />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /CSV/ })).toBeNull();
    expect(container.querySelector(".oc-iui-table-region.is-long")).toBeNull();
    expect(rowMatches(["上海", 1200], "1,200")).toBe(true);
    expect(rowMatches(["上海", 1200], "北京")).toBe(false);
  });

  it("markdown copy of an outline keeps its nesting", async () => {
    const writeText = mockClipboard();
    render(<IuiBlock code={j({ type: "outline", title: "提纲", items: [{ title: "一", children: ["甲"] }] })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制(Markdown)" }));
    });
    expect(writeText).toHaveBeenCalledWith(specToMarkdown(ok({ type: "outline", title: "提纲", items: [{ title: "一", children: ["甲"] }] }).spec));
    expect(writeText.mock.calls[0]![0]).toContain("- **一**\n  - 甲");
  });
});
