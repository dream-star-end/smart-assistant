import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIntelligentUiForTests } from "../../lib/intelligentUi";
import { OptionsBlock } from "../RichBlocks";
import { ChatInteractionContext } from "../tool/context";
import { IuiBlock } from "./IuiBlock";

const j = (v: unknown) => JSON.stringify(v);

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }),
  });
  __resetIntelligentUiForTests();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(cleanup);

describe("batch 1 intelligent UI upgrades", () => {
  it("OptionsBlock: allows attaching custom note before pick or sending free-form note directly", () => {
    const sendUserText = vi.fn();
    const code = j({ question: "发布环境?", options: [{ label: "灰度" }, { label: "全量" }] });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "补充说明后再发" }));
    fireEvent.change(screen.getByLabelText("补充说明"), { target: { value: "先只开白名单" } });
    fireEvent.click(screen.getByText("灰度"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:灰度（补充：先只开白名单）");

    cleanup();
    const sendFree = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText: sendFree }}>
        <OptionsBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "补充说明后再发" }));
    const noteInput = screen.getByLabelText("补充说明");
    fireEvent.compositionStart(noteInput);
    fireEvent.change(noteInput, { target: { value: "暂缓上线，等明天压测结果" } });
    fireEvent.keyDown(noteInput, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(sendFree).not.toHaveBeenCalled();
    fireEvent.compositionEnd(noteInput);
    fireEvent.keyDown(noteInput, { key: "Enter" });
    expect(sendFree).toHaveBeenCalledTimes(1);
    expect(sendFree).toHaveBeenCalledWith("暂缓上线，等明天压测结果");
  });

  it("TableBlock: medium tables offer collapsible search & TSV copy", async () => {
    const writeText = mockClipboard();
    const rows = Array.from({ length: 6 }, (_, i) => [`方案 ${i + 1}`, i === 2 ? "推荐" : "备选"]);
    render(<IuiBlock code={j({ type: "table", title: "对比", columns: ["名称", "结论"], rows })} />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开筛选" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "筛选表格行" }), { target: { value: "推荐" } });
    expect(screen.getByText("1 / 6 行")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制表格(TSV)" }));
    });
    expect(writeText).toHaveBeenCalledWith("名称\t结论\n方案 3\t推荐");
  });

  it("DraftBlock: inline editing updates word count and copied text, Markdown draft toggles preview", async () => {
    const writeText = mockClipboard();
    render(<IuiBlock code={j({ type: "draft", title: "通知", variants: [{ label: "正式", text: "## 周会取消\n\n请大家**本周五**正常推进各自需求。" }] })} />);
    fireEvent.click(screen.getByRole("button", { name: "排版预览" }));
    expect(screen.getByText("本周五").tagName).toBe("STRONG");

    fireEvent.click(screen.getByRole("button", { name: "编辑微调" }));
    fireEvent.change(screen.getByLabelText("编辑成稿正文"), { target: { value: "周会改至下周一上午。" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    });
    expect(writeText).toHaveBeenCalledWith("周会改至下周一上午。");
    fireEvent.click(screen.getByRole("button", { name: "恢复初稿" }));
    expect(screen.getByLabelText("编辑成稿正文")).toHaveValue("## 周会取消\n\n请大家**本周五**正常推进各自需求。");
  });

  it("StepsBlock: converts non-checkable steps into a persistent interactive checklist", () => {
    const code = j({ type: "steps", title: "上线前检查", items: ["跑单测", "清缓存"] });
    render(<IuiBlock code={code} />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "转为核对清单" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /跑单测/ }));
    expect(screen.getByText("1 / 2")).toHaveTextContent("已完成 1 / 2");
  });

  it("OutlineBlock: mindmap renders 4-level nodes and supports folding branches", () => {
    render(
      <IuiBlock
        code={j({
          type: "outline",
          title: "系统架构",
          items: [
            { title: "前端", children: [{ title: "智能 UI", children: [{ title: "文本类", children: ["思维导图四层节点"] }] }] },
            { title: "网关", children: ["围栏归一化"] },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "导图" }));
    expect(screen.getByText("思维导图四层节点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起分支 前端" }));
    expect(screen.queryByText("思维导图四层节点")).toBeNull();
  });

  it("CalculatorBlock: slider presets jump value and sends parameter follow-up", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock
          code={j({
            type: "calculator",
            title: "定投测算",
            inputs: [{ id: "years", label: "年数", kind: "slider", value: 10, min: 1, max: 40, step: 1, unit: "年" }],
            outputs: [{ id: "total", label: "总月数", formula: "years * 12", unit: "月", primary: true }],
          })}
        />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "设年数为 40年" }));
    expect(screen.getByText("480月")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "带此参数追问" }));
    expect(sendUserText).toHaveBeenCalledWith("基于当前定投测算参数继续分析：年数=40年（总月数：480月）");
  });

  it("FormBlock: supports textarea and lets user reopen form after submit", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={j({ type: "form", title: "需求登记", fields: [{ id: "desc", label: "详细说明", kind: "textarea", required: true }] })} />
      </ChatInteractionContext.Provider>,
    );
    const area = screen.getByLabelText(/详细说明/);
    expect(area.tagName).toBe("TEXTAREA");
    fireEvent.change(area, { target: { value: "需要支持导出 Excel" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(sendUserText).toHaveBeenCalledWith("需求登记:\n- 详细说明:需要支持导出 Excel");
    fireEvent.click(screen.getByRole("button", { name: "修改重填" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(screen.getByLabelText(/详细说明/)).toHaveValue("需要支持导出 Excel");
  });

  it("QuizBlock: supports going back to previous question and renders full review on result", () => {
    render(
      <IuiBlock
        code={j({
          type: "quiz",
          questions: [
            { question: "第一题", options: ["错", "对"], answer: 1, explain: "因为 B 对" },
            { question: "第二题", options: ["A", "B"], answer: 0 },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /错/ }));
    fireEvent.click(screen.getByRole("button", { name: /下一题/ }));
    fireEvent.click(screen.getByRole("button", { name: "上一题" }));
    expect(screen.getByText("第 1 题 · 共 2 题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^下一题/ }));
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: /看结果/ }));
    const review = screen.getByRole("list", { name: "逐题复盘" });
    expect(within(review).getByText(/第一题/)).toBeInTheDocument();
    expect(within(review).getByText("因为 B 对")).toBeInTheDocument();
  });

  it("GalleryBlock: opens interactive lightbox dialog with keyboard/button nav and closes on Escape", () => {
    render(
      <IuiBlock
        code={j({
          type: "gallery",
          title: "现场照片",
          images: [
            { src: "https://i.example/1.jpg", caption: "第一张" },
            { src: "https://i.example/2.jpg", caption: "第二张" },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "放大查看第 1 张图片：第一张" }));
    const dialog = screen.getByRole("dialog", { name: "现场照片 · 图片预览" });
    expect(within(dialog).getByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "下一张" }));
    expect(within(dialog).getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
