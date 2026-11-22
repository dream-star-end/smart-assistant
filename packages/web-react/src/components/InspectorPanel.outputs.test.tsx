/**
 * OCV5-372 详情面板「产出」页:默认分区、按轮翻看与跟随最新一轮、主产物直接渲染(网页沙盒 /
 * 文档 / 代码)、回放不出来时读容器文件、其余产出(图片 / 本机预览 / 参考来源)、摘要与空态。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { InspectorPanel, InspectorPanelContent, computeDynamicPaneMaxWidth } from "./InspectorPanel";
import { wrapWithCspOnly } from "./embedCsp";
import { prefetchMarkdownImpl } from "./Markdown";
import { preloadToolBody } from "./tool/lazyToolBody";
import { loadBeforeAll } from "../test/moduleLoad";

// 渲染工具卡展开体的断言要等懒加载的 tool bodies;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(preloadToolBody);
// 文档正文走懒加载的 Markdown 渲染器,同理先加载好。
loadBeforeAll(prefetchMarkdownImpl);

// 读容器文件的那条回落:测试里没有签名通道,直接替换受限读取(其余导出照旧)。
const fetchSignedCapped = vi.hoisted(() => vi.fn());
vi.mock("./project/outputPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project/outputPreview")>()),
  fetchSignedCapped,
}));
const bytes = (text: string) => ({ kind: "ok" as const, bytes: new TextEncoder().encode(text), type: "text/plain", truncated: false });

afterEach(cleanup);
beforeEach(() => {
  fetchSignedCapped.mockReset();
  fetchSignedCapped.mockRejectedValue(new Error("签名失败"));
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const TS = 1_700_000_000_000;
const user = (id: string, text: string, ts = TS): ChatMessage => ({ id, role: "user", text, ts, status: "replied" });
const assistant = (id: string, text: string, ts = TS): ChatMessage => ({ id, role: "assistant", text, ts });
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

const W = "/home/agent/.openclaude/workspace/s1";

function session(): ChatMessage[] {
  return [
    user("u1", "做一个落地页", TS),
    tool("s1", "WebSearch", { query: "landing" }, { output: "  - [Landing Patterns](https://www.example.org/landing): 指南" }),
    tool("w1", "Write", { file_path: `${W}/index.html`, content: "<h1>Hello</h1>\n" }, { ts: TS + 2000, completedAt: TS + 3000 }),
    tool("e1", "Edit", { file_path: `${W}/index.html`, old_string: "Hello", new_string: "Hello world" }, { ts: TS + 4000, completedAt: TS + 5000 }),
    tool("w2", "Write", { file_path: `${W}/style.css`, content: "h1 { color: red }\n" }),
    assistant("a1", `做好了,截图 \`${W}/shot.png\`,预览 http://localhost:5173/ 。`, TS + 65_000),
    user("u2", "写个说明", TS + 70_000),
    tool("w3", "Write", { file_path: `${W}/README.md`, content: "# 说明\n\n- 一\n- 二\n" }),
    assistant("a2", "写好了。", TS + 80_000),
  ];
}

/** 产出页是懒加载块:先等它挂上。 */
const outputsReady = () => screen.findByTestId(/^outputs-(view|empty)$/);

describe("产出页", () => {
  test("默认分区是产出,停在最新一轮;标题、摘要、翻轮", async () => {
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    await outputsReady();
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    const turn = screen.getByTestId("outputs-turn");
    expect(turn).toHaveTextContent("写个说明");
    expect(screen.getByTestId("outputs-turn-counter")).toHaveTextContent("第 2 / 2 轮");
    expect(screen.getByTestId("outputs-summary")).toHaveTextContent("用时 10 秒");
    expect(screen.getByTestId("outputs-summary")).toHaveTextContent("1 步");
    expect(screen.getByLabelText("下一轮")).toBeDisabled();

    fireEvent.click(screen.getByLabelText("上一轮"));
    expect(screen.getByTestId("outputs-turn")).toHaveTextContent("做一个落地页");
    expect(screen.getByTestId("outputs-summary")).toHaveTextContent("用时 1 分 5 秒");
    expect(screen.getByTestId("outputs-summary")).toHaveTextContent("4 步");
    expect(screen.getByTestId("outputs-summary")).toHaveTextContent("2 个文件");
  });

  test("主产物:网页用沙盒 iframe 渲染回放出的最终内容;可切源码 / 改动;其余产出列在下面", async () => {
    const messages = session();
    render(<InspectorPanelContent messages={messages} request={{ tab: "outputs", message: messages[2], nonce: 1 }} onClose={() => {}} />);
    await outputsReady();
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("index.html");
    const frame = await screen.findByTestId("output-preview-frame");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe(wrapWithCspOnly("<h1>Hello world</h1>\n"));
    // 与聊天里的 HTML 嵌入同一份 CSP,且排在模型代码之前
    expect(frame.getAttribute("srcdoc")).toMatch(/^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    expect(screen.getByTestId("outputs-hero-origin")).toHaveTextContent("内容来自会话记录");

    fireEvent.click(screen.getByRole("radio", { name: "源码" }));
    expect(await screen.findByTestId("output-preview-source")).toHaveTextContent("Hello world");
    fireEvent.click(screen.getByRole("radio", { name: "改动 2" }));
    expect(screen.getAllByTestId("pane-file-change")).toHaveLength(2);

    // 多产物精读态顶栏提供「← 文件列表 (3)」返回 Codex 目录总览，浏览全部文件 / 媒体 / 预览链接 / 来源
    const backBtn = screen.getByTestId("outputs-back-to-list");
    expect(backBtn).toHaveTextContent("文件列表");
    expect(backBtn).toHaveTextContent("(3)");
    fireEvent.click(backBtn);

    expect(screen.getByTestId("outputs-directory")).toBeInTheDocument();
    expect(screen.getByTestId("outputs-directory-header")).toHaveTextContent("文件与产出 · 3 项");
    const files = screen.getAllByTestId("outputs-file");
    expect(files.map((f) => f.textContent)).toEqual([expect.stringContaining("index.html"), expect.stringContaining("style.css")]);
    expect(screen.getAllByTestId("outputs-media")).toHaveLength(1);
    const link = screen.getByTestId("outputs-link");
    expect(link).toHaveAttribute("href", "http://localhost:5173/");
    const source = screen.getByTestId("outputs-source");
    expect(source).toHaveTextContent("Landing Patterns");
    expect(source).toHaveTextContent("example.org");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");

    // 点别的文件 → 进入单文件精读视图
    fireEvent.click(files[1]);
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("style.css");
    expect(await screen.findByTestId("output-preview-source")).toHaveTextContent("color: red");
  });

  test("文档渲染成排版好的正文", async () => {
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    await outputsReady();
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("README.md");
    const md = await screen.findByTestId("output-preview-markdown");
    expect(await within(md).findByRole("heading", { name: "说明" })).toBeInTheDocument();
    expect(within(md).getAllByRole("listitem")).toHaveLength(2);
  });

  test("回放不出来(只有 Edit)→ 读容器里的当前文件;读不到给「重试读取」并自动隐藏「批注修改」", async () => {
    render(
      <InspectorPanelContent
        messages={[user("u1", "改一下"), tool("e1", "Edit", { file_path: `${W}/app.py`, old_string: "a", new_string: "b" })]}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.getByTestId("outputs-hero-origin")).toHaveTextContent("容器里的当前文件");
    // 测试环境没有签名通道 → 读取失败,展示人话「重试读取」并隐藏「批注修改」
    expect(await screen.findByText("没能读取这个文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试读取" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
    expect(screen.queryByTestId("hero-quick-annotate")).toBeNull();
  });

  test("读容器文件的回落:文件又被改过(新的一次 Edit 完成)就重读", async () => {
    fetchSignedCapped.mockResolvedValueOnce(bytes("VERSION-B")).mockResolvedValueOnce(bytes("VERSION-C"));
    const first = [user("u1", "改一下"), tool("e1", "Edit", { file_path: `${W}/app.py`, old_string: "a", new_string: "b" })];
    const { rerender } = render(<InspectorPanelContent messages={first} onClose={() => {}} />);
    await outputsReady();
    expect(await screen.findByText(/VERSION-B/)).toBeInTheDocument();
    const second = [...first, tool("e2", "Edit", { file_path: `${W}/app.py`, old_string: "b", new_string: "c" })];
    rerender(<InspectorPanelContent messages={second} onClose={() => {}} />);
    expect(await screen.findByText(/VERSION-C/)).toBeInTheDocument();
    expect(fetchSignedCapped).toHaveBeenCalledTimes(2);
  });

  test("读容器文件的回落:提到这个文件的脚本命令跑完后重读(命令返回时才写)", async () => {
    fetchSignedCapped.mockResolvedValueOnce(bytes("OLD-CONTENT")).mockResolvedValueOnce(bytes("NEW-CONTENT"));
    const write = tool("w1", "Write", { file_path: "/tmp/a.md", content: "old\n" });
    const script = { command: "sleep 2; python3 -c \"open('/tmp/a.md','w').write('new')\"" };
    const running = [user("u1", "改"), write, tool("b1", "Bash", script, { _completed: false, output: "" })];
    const { rerender } = render(<InspectorPanelContent messages={running} running onClose={() => {}} />);
    await outputsReady();
    fireEvent.click(screen.getByRole("radio", { name: "源码" }));
    expect(await screen.findByText(/OLD-CONTENT/)).toBeInTheDocument();
    const done = [user("u1", "改"), write, tool("b1", "Bash", script, { _completed: true, output: "" })];
    rerender(<InspectorPanelContent messages={done} running onClose={() => {}} />);
    expect(await screen.findByText(/NEW-CONTENT/)).toBeInTheDocument();
    expect(screen.getByTestId("outputs-hero-origin")).toHaveTextContent("容器里的当前文件");
  });

  test("运行中:新一轮开始自动跟过去;翻到旧轮后停在旧轮", async () => {
    const first = session().slice(0, 6);
    const { rerender } = render(<InspectorPanelContent messages={first} running onClose={() => {}} />);
    await outputsReady();
    expect(screen.getByTestId("outputs-turn")).toHaveTextContent("进行中");
    const second = [...first, user("u2", "再来一轮", TS + 70_000)];
    rerender(<InspectorPanelContent messages={second} running onClose={() => {}} />);
    expect(screen.getByTestId("outputs-turn")).toHaveTextContent("再来一轮");
    expect(screen.getByTestId("outputs-none")).toHaveTextContent("这一轮还在进行");

    fireEvent.click(screen.getByLabelText("上一轮"));
    const third = [...second, assistant("a2", "好"), user("u3", "第三轮")];
    rerender(<InspectorPanelContent messages={third} running onClose={() => {}} />);
    expect(screen.getByTestId("outputs-turn")).toHaveTextContent("做一个落地页");
  });

  test("OCV5-844: 没有产出的轮给安静空态，不渲染冗余「查看步骤」按钮与常驻「过程」Tab", async () => {
    render(
      <InspectorPanelContent
        messages={[user("u1", "跑一下测试"), tool("b1", "Bash", { command: "npm test" }), assistant("a1", "都过了")]}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("outputs-open-steps")).toBeNull();
    const empty = screen.getByTestId("outputs-none");
    expect(empty).toHaveTextContent("这一轮没有产出文件");
    expect(empty).toHaveTextContent("展开左侧完成摘要即可查看本轮执行过程");
    expect(empty).not.toHaveTextContent("查看步骤");
  });

  test("参考来源默认列 5 条,其余收在「显示全部」里", async () => {
    const links = Array.from({ length: 8 }, (_, i) => ({ title: `来源 ${i + 1}`, url: `https://s${i + 1}.example.com/` }));
    render(
      <InspectorPanelContent
        messages={[user("u1", "查"), tool("s1", "WebSearch", { query: "q" }, { output: `Links: ${JSON.stringify(links)}` })]}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.getAllByTestId("outputs-source")).toHaveLength(5);
    fireEvent.click(screen.getByTestId("outputs-sources-more"));
    expect(screen.getAllByTestId("outputs-source")).toHaveLength(8);
    expect(screen.getByTestId("outputs-sources-more")).toHaveTextContent("收起");
  });

  test("会话还没有任何轮:整页空态", async () => {
    render(<InspectorPanelContent messages={[]} onClose={() => {}} />);
    await outputsReady();
    expect(screen.getByTestId("outputs-empty")).toHaveTextContent("还没有产出");
  });

  test("targetPath 定位请求跨轮跳转并自动高亮选中目标产物", async () => {
    render(
      <InspectorPanelContent
        messages={session()}
        request={{ tab: "outputs", targetPath: `${W}/style.css`, nonce: 7 }}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    // style.css 位于第 1 轮，自动翻回第 1 轮并成为主产物
    expect(screen.getByTestId("outputs-turn-counter")).toHaveTextContent("第 1 / 2 轮");
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("style.css");
  });

  test("宽屏动态上限计算与全屏影院阅读模式切换", async () => {
    expect(computeDynamicPaneMaxWidth(1920, 268)).toBe(1120);
    expect(computeDynamicPaneMaxWidth(1200, 268)).toBe(512);

    render(<InspectorPanel messages={session()} width={440} onClose={() => {}} />);
    await outputsReady();
    fireEvent.click(screen.getByTestId("pane-fullscreen-toggle"));
    expect(screen.getByTestId("pane-fullscreen-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("pane-fullscreen-docked")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("pane-fullscreen-dialog")).getByTestId("pane-fullscreen-toggle"));
    expect(screen.queryByTestId("pane-fullscreen-dialog")).toBeNull();
  });

  test("移动端底部 Sheet「2-Bar」紧凑阅读器：去 header-safe-t、单轮单文件全出血无套娃、多轮/多文件出极轻微条", async () => {
    const onToggleFullscreen = vi.fn();
    const singleFileMessages: ChatMessage[] = [
      user("u1", "帮我整理一份很长的产品架构分析报告并总结重点", TS),
      tool("w1", "Write", { file_path: `${W}/report.md`, content: "# 架构分析\n\n核心结论正文。\n" }),
      assistant("a1", "已完成。", TS + 10_000),
    ];

    const { rerender } = render(
      <InspectorPanelContent
        messages={singleFileMessages}
        sheet
        fullscreen={false}
        onToggleFullscreen={onToggleFullscreen}
        onClose={() => {}}
      />,
    );
    await outputsReady();

    // 底部 Sheet 非全屏态去掉多余 header-safe-t；支持切全屏
    expect(screen.getByTestId("pane-header")).not.toHaveClass("header-safe-t");
    fireEvent.click(screen.getByTestId("pane-fullscreen-toggle"));
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);

    // 单轮单文件直接全出血进预览：无 TurnBar、无微条、无 max-h-[68vh] 嵌套滚动
    expect(screen.queryByTestId("outputs-turn")).toBeNull();
    expect(screen.queryByTestId("outputs-open-steps")).toBeNull();
    expect(screen.queryByTestId("outputs-compact-strip")).toBeNull();
    expect(screen.getByTestId("outputs-hero")).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("outputs-hero-body").className).not.toContain("max-h-[68vh]");
    expect(await screen.findByTestId("output-preview-markdown")).toBeInTheDocument();
    expect(screen.getByTestId("workbench-bottom-bar")).toBeInTheDocument();

    // 全屏态恢复 header-safe-t 顶部安全区
    rerender(
      <InspectorPanelContent
        messages={session()}
        sheet
        fullscreen
        onToggleFullscreen={onToggleFullscreen}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.getByTestId("pane-header")).toHaveClass("header-safe-t");

    // 多轮单文件时显示清晰的「第 2/2 轮」微条，翻到多产物轮次默认展示 Codex 文件目录总览而非盲翻
    expect(screen.queryByTestId("outputs-turn")).toBeNull();
    expect(screen.queryByTestId("outputs-open-steps")).toBeNull();
    const strip = screen.getByTestId("outputs-compact-strip");
    expect(strip).toHaveTextContent("第 2/2 轮");
    fireEvent.click(within(strip).getByLabelText("上一轮"));
    expect(screen.getByTestId("outputs-directory")).toBeInTheDocument();
    expect(screen.getByTestId("outputs-directory-header")).toHaveTextContent("文件与产出 · 3 项");
    expect(screen.getByTestId("outputs-turn-counter")).toHaveTextContent("第 1/2 轮");

    // 点击文件平滑进入精读视图，顶栏展示「← 文件列表 (3)」与前后文件切换钮
    fireEvent.click(screen.getAllByTestId("outputs-file")[0]);
    expect(screen.getByTestId("outputs-back-to-list")).toHaveTextContent("(3)");
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("index.html");
    fireEvent.click(screen.getByLabelText("下一份文件"));
    expect(screen.getByTestId("outputs-hero-name")).toHaveTextContent("style.css");
  });

  test("Codex 两级体验 + 幽灵路径过滤 + 移动端报错态提供「重试读取 / 返回文件列表」并隐藏「批注修改」", async () => {
    const messages: ChatMessage[] = [
      user("u1", "构建并改两个文件", TS),
      tool("e1", "Edit", { file_path: `${W}/missing.ts`, old_string: "a", new_string: "b" }),
      tool("w1", "Write", { file_path: `${W}/notes.md`, content: "# 说明\n内容\n" }),
      assistant(
        "a1",
        "构建输出 `/assets/styles-1VWWTp9J.css`、宿主机 `/var/lib/docker/volumes/oc/_data/x.ts`、`/opt/openclaude/a.ts`。",
        TS + 5_000,
      ),
    ];

    render(<InspectorPanelContent messages={messages} sheet onClose={() => {}} />);
    await outputsReady();

    // 幽灵路径被彻底过滤，仅剩 2 个真实工作区文件，且默认打开 Codex 目录总览
    expect(screen.getByTestId("outputs-directory")).toBeInTheDocument();
    expect(screen.getByTestId("outputs-directory-header")).toHaveTextContent("文件与产出 · 2 项");
    const rows = screen.getAllByTestId("outputs-file");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("missing.ts"),
      expect.stringContaining("notes.md"),
    ]);
    expect(screen.queryByText(/styles-1VWWTp9J\.css/)).toBeNull();

    // 点开不可读的 missing.ts → 报错态给出「重试读取」与「返回文件列表」，并自动隐藏「批注修改」
    fireEvent.click(rows[0]);
    expect(await screen.findByText("没能读取这个文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试读取" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /返回文件列表/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("hero-quick-annotate")).toBeNull();
    expect(screen.queryByRole("button", { name: /批注修改/ })).toBeNull();

    // 点击「返回文件列表」回到目录总览
    fireEvent.click(screen.getByTestId("outputs-back-to-list"));
    expect(screen.getByTestId("outputs-directory")).toBeInTheDocument();
  });
});
