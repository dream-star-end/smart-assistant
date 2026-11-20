/**
 * OCV5-811 右侧统一 Workbench 交付物富预览与批注回填集成单测：
 *   1. CSV 表格预览器：搜索过滤、数值列排序、CSV 切片复制、按行定位批注回填 Composer；
 *   2. Markdown 幻灯片逐页预览器：16:9 画布翻页、缩略条跳转、演讲备注展开、无回调时剪贴板复制 + Toast 兜底；
 *   3. 二进制 PPTX 演示文稿：优雅元信息卡 + 一键让 Agent 导出预览图/转 Markdown 大纲；
 *   4. 长文档阅读器：字数与阅读时长统计、可折叠 H1–H3 大纲、按章节定位批注；
 *   5. InspectorPanel 端到端集成：产物分类汇总筛选条、透传 onAnnotateToComposer、BrowserView 状态引导提示。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import { loadBeforeAll } from "../../test/moduleLoad";
import { InspectorPanelContent } from "../InspectorPanel";
import { prefetchMarkdownImpl } from "../Markdown";
import { ToastProvider } from "../ui";
import { DeliverableRichPreview } from "./DeliverableRichPreview";

loadBeforeAll(prefetchMarkdownImpl);

afterEach(cleanup);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("DeliverableRichPreview · 表格预览器（CSV/TSV）", () => {
  const CSV = [
    "模型,准确率,延迟",
    "Baseline,81.5,420",
    "GPT-5,94.2,1150",
    "Claude-4,96.0,980",
  ].join("\n");

  test("支持搜索过滤、数值列排序、复制 CSV 切片与按行定位批注回填", async () => {
    const onAnnotate = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ToastProvider>
        <DeliverableRichPreview
          path="/home/agent/.openclaude/workspace/eval/scores.csv"
          text={CSV}
          onAnnotateToComposer={onAnnotate}
        />
      </ToastProvider>,
    );

    expect(screen.getByTestId("deliverable-type-badge")).toHaveTextContent("表格 · CSV");
    expect(screen.getByTestId("spreadsheet-counts")).toHaveTextContent("共 3 行 · 3 列");
    expect(screen.getByTestId("spreadsheet-numeric-stats")).toHaveTextContent("准确率");

    // 按准确率列升序 → 再降序
    const accBtn = screen.getByRole("button", { name: "准确率" });
    fireEvent.click(accBtn);
    let rows = screen.getAllByTestId("spreadsheet-row");
    expect(rows[0]).toHaveTextContent("Baseline");
    fireEvent.click(accBtn);
    rows = screen.getAllByTestId("spreadsheet-row");
    expect(rows[0]).toHaveTextContent("Claude-4");

    // 关键词过滤
    fireEvent.change(screen.getByTestId("spreadsheet-filter"), { target: { value: "GPT" } });
    expect(screen.getAllByTestId("spreadsheet-row")).toHaveLength(1);
    expect(screen.getByTestId("spreadsheet-counts")).toHaveTextContent("匹配 1 / 3 行");

    // 复制当前筛选切片
    fireEvent.click(screen.getByTestId("spreadsheet-copy-csv"));
    expect(writeText).toHaveBeenCalledWith("模型,准确率,延迟\nGPT-5,94.2,1150");
    expect(await screen.findByText(/已复制 1 行 CSV 切片/)).toBeInTheDocument();

    // 点该行「批注」→ 打开定位到原始第 3 行的批注框 → 回填 Composer
    fireEvent.click(screen.getByRole("button", { name: "批注第 3 行" }));
    expect(screen.getByTestId("deliverable-annotate-anchor")).toHaveTextContent("第 3 行");
    fireEvent.change(screen.getByTestId("deliverable-annotate-input"), {
      target: { value: "核对延迟单位并补充标准差" },
    });
    fireEvent.click(screen.getByTestId("deliverable-annotate-submit"));

    expect(onAnnotate).toHaveBeenCalledTimes(1);
    const prompt = String(onAnnotate.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("/home/agent/.openclaude/workspace/eval/scores.csv");
    expect(prompt).toContain("第 3 行");
    expect(prompt).toContain("核对延迟单位并补充标准差");
  });
});

describe("DeliverableRichPreview · 幻灯片与二进制 Office", () => {
  const DECK = [
    "---",
    "marp: true",
    "title: 论文汇报",
    "---",
    "# 研究背景",
    "一句话动机",
    "<!-- notes: 提醒听众关注吞吐瓶颈 -->",
    "---",
    "## 方法架构",
    "- 模块 A",
    "- 模块 B",
    "---",
    "## 实验结果",
    "准确率提升 14.5%",
  ].join("\n");

  test("16:9 画布左右翻页、缩略条跳转、演讲备注展开，无回填回调时自动复制并 toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ToastProvider>
        <DeliverableRichPreview path="/w/slides.md" text={DECK} />
      </ToastProvider>,
    );

    expect(screen.getByTestId("deliverable-slides")).toBeInTheDocument();
    expect(screen.getByTestId("slide-counter")).toHaveTextContent("第 1 / 3 页");
    expect(await within(screen.getByTestId("slide-stage")).findByText("研究背景")).toBeInTheDocument();

    // 展开演讲者备注
    fireEvent.click(screen.getByRole("button", { name: "演讲者备注" }));
    expect(screen.getByText("提醒听众关注吞吐瓶颈")).toBeInTheDocument();

    // 下一页 & 缩略条直接跳第 3 页
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByTestId("slide-counter")).toHaveTextContent("第 2 / 3 页");

    const thumbs = screen.getAllByTestId("slide-thumb");
    expect(thumbs).toHaveLength(3);
    fireEvent.click(thumbs[2]);
    expect(screen.getByTestId("slide-counter")).toHaveTextContent("第 3 / 3 页");
    expect(thumbs[2]).toHaveAttribute("aria-current", "true");

    // 批注第 3 页（不传 onAnnotateToComposer → 复制并 toast）
    fireEvent.click(screen.getByTestId("slide-annotate-current"));
    expect(screen.getByTestId("deliverable-annotate-anchor")).toHaveTextContent("第 3 页（实验结果）");
    fireEvent.change(screen.getByTestId("deliverable-annotate-input"), {
      target: { value: "把数字加粗并补充对比基线" },
    });
    fireEvent.click(screen.getByTestId("deliverable-annotate-submit"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0] ?? "")).toContain("第 3 页（实验结果）");
    expect(await screen.findByText(/已复制修改指令/)).toBeInTheDocument();
  });

  test("二进制 .pptx 呈现优雅元信息卡与一键让 Agent 导出预览图/转大纲按钮", async () => {
    const onAnnotate = vi.fn();
    render(
      <ToastProvider>
        <DeliverableRichPreview path="/w/quarterly.pptx" onAnnotateToComposer={onAnnotate} />
      </ToastProvider>,
    );

    expect(screen.getByTestId("deliverable-binary-office")).toBeInTheDocument();
    expect(screen.getByText("quarterly.pptx")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("binary-office-convert"));
    expect(onAnnotate).toHaveBeenCalledTimes(1);
    expect(String(onAnnotate.mock.calls[0]?.[0] ?? "")).toContain("/w/quarterly.pptx");
    expect(String(onAnnotate.mock.calls[0]?.[0] ?? "")).toContain("预览图");
  });
});

describe("DeliverableRichPreview · 长文档阅读器", () => {
  const DOC = [
    "# 行业深度调研报告",
    "",
    "本报告覆盖 2026 年核心技术演进与落地实践。",
    "",
    "## 一、市场格局",
    "主要玩家集中在代码与科研工具链。",
    "",
    "## 二、结论与建议",
    "优先建设右侧统一工作区。",
  ].join("\n");

  test("显示字数与阅读时长统计、可折叠大纲目录、并支持按章节发起批注", async () => {
    const onAnnotate = vi.fn();
    render(
      <ToastProvider>
        <DeliverableRichPreview path="/w/research.md" text={DOC} onAnnotateToComposer={onAnnotate} />
      </ToastProvider>,
    );

    expect(screen.getByTestId("doc-stats-bar")).toHaveTextContent(/约 \d+ 字/);
    expect(screen.getByTestId("doc-stats-bar")).toHaveTextContent(/阅读约 \d+ 分钟/);
    expect(screen.getByTestId("doc-outline-list")).toBeInTheDocument();

    // 折叠再展开目录
    fireEvent.click(screen.getByTestId("doc-outline-toggle"));
    expect(screen.queryByTestId("doc-outline-list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("doc-outline-toggle"));
    expect(screen.getByTestId("doc-outline-list")).toBeInTheDocument();

    // 按章节「二、结论与建议」发起批注
    fireEvent.click(screen.getByRole("button", { name: "批注章节 二、结论与建议" }));
    expect(screen.getByTestId("deliverable-annotate-anchor")).toHaveTextContent("章节「二、结论与建议」");
    fireEvent.change(screen.getByTestId("deliverable-annotate-input"), {
      target: { value: "补充三点可量化的落地里程碑" },
    });
    fireEvent.click(screen.getByTestId("deliverable-annotate-submit"));
    expect(onAnnotate).toHaveBeenCalledWith(expect.stringContaining("章节「二、结论与建议」"));
  });
});

describe("InspectorPanel 端到端集成（产物分类汇总筛选 + 批注透传 + BrowserView 引导提示）", () => {
  const TS = 1_700_000_000_000;
  const user = (id: string, text: string): ChatMessage => ({ id, role: "user", text, ts: TS, status: "replied" });
  const tool = (id: string, toolName: string, inputJson: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: "tool",
    text: toolName,
    ts: TS,
    toolName,
    inputJson,
    _completed: true,
    output: "ok",
    ...extra,
  });

  test("产出页展示交付物汇总筛选条，切到表格文件可在线筛选并透传批注到 onAnnotateToComposer", async () => {
    const onAnnotate = vi.fn();
    const messages: ChatMessage[] = [
      user("u1", "整理实验数据并写脚本"),
      tool("w1", "Write", { file_path: "/w/results.csv", content: "epoch,loss\n1,0.82\n2,0.41\n" }),
      tool("w2", "Write", { file_path: "/w/train.py", content: "print('ok')\n" }),
      { id: "a1", role: "assistant", text: "另附汇报 `/w/summary.pptx`。", ts: TS },
    ];

    render(
      <ToastProvider>
        <InspectorPanelContent messages={messages} onClose={() => {}} onAnnotateToComposer={onAnnotate} />
      </ToastProvider>,
    );

    const strip = await screen.findByTestId("outputs-summary-strip");
    expect(strip).toHaveTextContent("全部3");
    expect(strip).toHaveTextContent("表格1");
    expect(strip).toHaveTextContent("代码1");
    expect(strip).toHaveTextContent("幻灯片1");

    // 筛选仅看表格
    fireEvent.click(screen.getByTestId("outputs-filter-spreadsheet"));
    const filteredFiles = screen.getAllByTestId("outputs-file");
    expect(filteredFiles).toHaveLength(1);
    expect(filteredFiles[0]).toHaveTextContent("results.csv");

    // 点开 CSV → 懒加载 DeliverableRichPreview 渲染表格并支持按行批注
    fireEvent.click(filteredFiles[0]);
    expect(await screen.findByTestId("deliverable-spreadsheet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批注第 2 行" }));
    fireEvent.change(screen.getByTestId("deliverable-annotate-input"), { target: { value: "重新确认 loss 精度" } });
    fireEvent.click(screen.getByTestId("deliverable-annotate-submit"));
    expect(onAnnotate).toHaveBeenCalledWith(expect.stringContaining("results.csv"));
  });

  test("BrowserView 展示清晰的快照/回放状态引导提示，切换历史步骤可点击「回到最新」", async () => {
    const page = (url: string, title: string, shot: string) =>
      `- Page URL: ${url}\n- Page Title: ${title}\n- [Screenshot of viewport](${shot})`;
    const messages: ChatMessage[] = [
      user("u1", "打开网页截图"),
      tool("b1", "Bash", { command: "oc-browser goto https://a.example && oc-browser screenshot" }, {
        output: page("https://a.example", "Page A", ".playwright-cli/1.png"),
      }),
      tool("b2", "Bash", { command: "oc-browser click e1 && oc-browser screenshot" }, {
        output: page("https://a.example/next", "Page B", ".playwright-cli/2.png"),
      }),
    ];

    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: "browser", message: messages[2], nonce: 1 }}
        onClose={() => {}}
      />,
    );

    const banner = await screen.findByTestId("browser-status-banner");
    expect(banner).toHaveTextContent("会话快照回放");

    // 点第一条历史操作 → 提示历史快照并出「回到最新」
    const rows = screen.getAllByTestId("browser-log-row");
    fireEvent.click(within(rows[0]).getAllByRole("button")[0]);
    expect(screen.getByTestId("browser-status-banner")).toHaveTextContent("历史快照 · 第 1 / 2 步");
    fireEvent.click(screen.getByTestId("browser-back-latest"));
    expect(screen.getByTestId("browser-status-banner")).toHaveTextContent("会话快照回放");
  });

  test("长文档点击大纲章节真实滚动到目标标题，且流式内容增长会自动解开幻灯片/目录锁死", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // 1. 先渲染单标题片段（模拟流式刚开始），目录默认折叠
    const { rerender } = render(
      <ToastProvider>
        <DeliverableRichPreview path="/w/streaming.md" text="# 初始标题\n\n第一段" />
      </ToastProvider>,
    );
    expect(screen.queryByTestId("doc-outline-list")).not.toBeInTheDocument();

    // 2. 流式增长出现第 2、3 个标题 → 目录自动展开，点击章节真实触发滚动
    const grownDoc = [
      "# 初始标题",
      "",
      "第一段",
      "",
      "## 第二节 方法",
      "方法内容",
      "",
      "## 第三节 结论",
      "结论内容",
    ].join("\n");
    rerender(
      <ToastProvider>
        <DeliverableRichPreview path="/w/streaming.md" text={grownDoc} />
      </ToastProvider>,
    );
    expect(screen.getByTestId("doc-outline-list")).toBeInTheDocument();
    await within(screen.getByTestId("output-preview-markdown")).findByRole("heading", { name: "第三节 结论" });

    const tocBtn = screen.getByRole("button", { name: "第三节 结论" });
    fireEvent.click(tocBtn);
    expect(tocBtn).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).toHaveBeenCalled();

    // 3. 流式 Marp 幻灯片：首段未含 `---`，后续补齐分页自动进入幻灯片模式
    const { rerender: rerenderSlides } = render(
      <ToastProvider>
        <DeliverableRichPreview path="/w/pitch-deck.md" text={"---\nmarp: true\n---\n# 封面"} />
      </ToastProvider>,
    );
    expect(screen.queryByTestId("deliverable-slides")).not.toBeInTheDocument();
    rerenderSlides(
      <ToastProvider>
        <DeliverableRichPreview
          path="/w/pitch-deck.md"
          text={"---\nmarp: true\n---\n# 封面\n---\n## 第二页\n内容"}
        />
      </ToastProvider>,
    );
    expect(screen.getByTestId("deliverable-slides")).toBeInTheDocument();
  });

  test("2-Bar 沉浸阅读器：Slides/文档无顶部重复工具条与重复批注按钮，隐藏 /api/media 长路径，移动紧凑态目录默认折叠", async () => {
    const SLIDES = "---\nmarp: true\n---\n# 封面页\n内容\n---\n## 第二页\n细节";
    render(
      <ToastProvider>
        <DeliverableRichPreview path="/api/media/sha256deadbeef" name="deck.md" text={SLIDES} />
      </ToastProvider>,
    );

    // Slides 仅保留底部唯一操作栏，不再渲染顶部 deliverable-action-bar，也不暴露 /api/media 长路径
    expect(screen.queryByTestId("deliverable-action-bar")).toBeNull();
    expect(screen.queryByTestId("deliverable-annotate-trigger")).toBeNull();
    expect(screen.queryByText(/\/api\/media\/sha256deadbeef/)).toBeNull();
    const bottomBar = screen.getByTestId("workbench-bottom-bar");
    const slideAnnotate = within(bottomBar).getByTestId("slide-annotate-current");
    expect(slideAnnotate).toHaveTextContent("批注修改");
    fireEvent.click(slideAnnotate);
    expect(screen.getByTestId("deliverable-annotate-anchor")).toHaveTextContent("第 1 页（封面页）");

    // 二进制 Office 在 showActionBar=true 时不出现重复批注按钮，也不暴露 /api/media 路径
    cleanup();
    render(
      <ToastProvider>
        <DeliverableRichPreview path="/api/media/sha256pptx" name="q4.pptx" />
      </ToastProvider>,
    );
    expect(screen.getAllByRole("button", { name: /批注/ })).toHaveLength(1);
    expect(screen.queryByText(/\/api\/media\/sha256pptx/)).toBeNull();

    // 移动端紧凑视口（<640px）：长文档默认折叠目录让正文首屏直达，点底部目录按钮展开
    cleanup();
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes("max-width: 639"),
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      render(
        <ToastProvider>
          <DeliverableRichPreview
            path="/w/mobile-doc.md"
            text={"# 总览\n\n正文\n\n## 第一节\n细节\n\n## 第二节\n总结"}
          />
        </ToastProvider>,
      );
      expect(screen.queryByTestId("deliverable-action-bar")).toBeNull();
      expect(screen.queryByTestId("doc-outline-list")).toBeNull();
      const docBar = screen.getByTestId("workbench-bottom-bar");
      fireEvent.click(within(docBar).getByTestId("doc-outline-toggle"));
      expect(screen.getByTestId("doc-outline-list")).toBeInTheDocument();
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });
});
