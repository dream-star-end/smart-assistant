/**
 * OCV5-372 详情面板「产出」页:默认分区、按轮翻看与跟随最新一轮、主产物直接渲染(网页沙盒 /
 * 文档 / 代码)、回放不出来时读容器文件、其余产出(图片 / 本机预览 / 参考来源)、摘要与空态。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { InspectorPanelContent } from "./InspectorPanel";

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
    expect(frame.getAttribute("srcdoc")).toBe("<h1>Hello world</h1>\n");
    expect(screen.getByTestId("outputs-hero-origin")).toHaveTextContent("内容来自会话记录");

    fireEvent.click(screen.getByRole("radio", { name: "源码" }));
    expect(await screen.findByTestId("output-preview-source")).toHaveTextContent("Hello world");
    fireEvent.click(screen.getByRole("radio", { name: "改动 2" }));
    expect(screen.getAllByTestId("pane-file-change")).toHaveLength(2);

    const files = screen.getAllByTestId("outputs-file");
    expect(files.map((f) => f.textContent)).toEqual([expect.stringContaining("index.html"), expect.stringContaining("style.css")]);
    expect(files[0]).toHaveAttribute("aria-current", "true");
    expect(screen.getAllByTestId("outputs-media")).toHaveLength(1);
    const link = screen.getByTestId("outputs-link");
    expect(link).toHaveAttribute("href", "http://localhost:5173/");
    const source = screen.getByTestId("outputs-source");
    expect(source).toHaveTextContent("Landing Patterns");
    expect(source).toHaveTextContent("example.org");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");

    // 点别的文件 → 成为主产物
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

  test("回放不出来(只有 Edit)→ 读容器里的当前文件;读不到给重试", async () => {
    render(
      <InspectorPanelContent
        messages={[user("u1", "改一下"), tool("e1", "Edit", { file_path: `${W}/app.py`, old_string: "a", new_string: "b" })]}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.getByTestId("outputs-hero-origin")).toHaveTextContent("容器里的当前文件");
    // 测试环境没有签名通道 → 读取失败,给重试
    expect(await screen.findByText("没能读取这个文件（可能已被移动或删除）。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
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

  test("没有产出的轮给安静的空态,「查看步骤」进步骤页", async () => {
    render(
      <InspectorPanelContent
        messages={[user("u1", "跑一下测试"), tool("b1", "Bash", { command: "npm test" }), assistant("a1", "都过了")]}
        onClose={() => {}}
      />,
    );
    await outputsReady();
    expect(screen.getByTestId("outputs-none")).toHaveTextContent("这一轮没有产出文件");
    fireEvent.click(screen.getByTestId("outputs-open-steps"));
    expect(screen.getByRole("tab", { name: /步骤/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-step-list")).toBeInTheDocument();
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
});
