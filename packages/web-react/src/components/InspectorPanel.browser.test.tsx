/**
 * OCV5-374 详情面板「浏览器」页:只在这一轮用过浏览器时出现;从浏览器卡点进来停在那一步;
 * 窗口显示地址 / 标题 / 截图,操作记录可切换、可进步骤详情;不在顶层轮里的浏览器步退回步骤页。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { loadBeforeAll } from "../test/moduleLoad";
import { InspectorPanelContent, PANE_TAB_STORAGE_KEY } from "./InspectorPanel";
import { preloadToolBody } from "./tool/lazyToolBody";

// 「详情」进步骤页会渲染工具卡展开体(懒加载);先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(preloadToolBody);

afterEach(cleanup);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const TS = 1_700_000_000_000;
const user = (id: string, text: string, ts = TS): ChatMessage => ({ id, role: "user", text, ts, status: "replied" });
const assistant = (id: string, text: string, ts = TS): ChatMessage => ({ id, role: "assistant", text, ts });
const bash = (id: string, command: string, output: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "tool",
  text: "Bash",
  ts: TS,
  toolName: "Bash",
  inputJson: { command },
  _completed: true,
  output,
  ...extra,
});

const page = (url: string, title: string, shot?: string) =>
  [`- Page URL: ${url}`, `- Page Title: ${title}`, ...(shot ? [`- [Screenshot of viewport](${shot})`] : [])].join("\n");

function session(): ChatMessage[] {
  return [
    user("u1", "做个演示页并截图检查"),
    bash("srv", "python3 -m http.server 8765", "ok"),
    bash("b1", "oc-browser goto 'http://127.0.0.1:8765/demo.html' && oc-browser screenshot", page("http://127.0.0.1:8765/demo.html", "Demo", ".playwright-cli/one.png")),
    bash("b2", "oc-browser click e32 && oc-browser screenshot", page("http://127.0.0.1:8765/demo.html#saturn", "Demo · Saturn", ".playwright-cli/two.png")),
    bash("b3", "oc-browser open 'file:///tmp/x.html'", "### Error\nError: Access to \"file:\" protocol is blocked.\nexit 1", { error: true }),
    assistant("a1", "好了", TS + 60_000),
    user("u2", "再写个说明", TS + 70_000),
    bash("w", "echo hi > README.md", "ok"),
    assistant("a2", "写好了", TS + 80_000),
  ];
}

const browserReady = () => screen.findByTestId("browser-view");

describe("浏览器页", () => {
  test("最新一轮没用浏览器:没有「浏览器」分区;记着上次停在浏览器也退回产出", async () => {
    localStorage.setItem(PANE_TAB_STORAGE_KEY, "browser");
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    await screen.findByTestId(/^outputs-(view|empty)$/);
    expect(screen.queryByRole("tab", { name: /浏览器/ })).toBeNull();
  });

  test("从浏览器卡点进来:分区计数、停在那一步、地址 / 标题 / 截图", async () => {
    const messages = session();
    render(<InspectorPanelContent messages={messages} request={{ tab: "browser", message: messages[2], nonce: 1 }} onClose={() => {}} />);
    await browserReady();
    const tab = screen.getByRole("tab", { name: /浏览器/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveTextContent("3");
    const windowEl = screen.getByTestId("browser-window");
    expect(within(windowEl).getByTestId("browser-address")).toHaveAttribute("href", "http://127.0.0.1:8765/demo.html");
    expect(within(windowEl).getByTestId("browser-window-title")).toHaveTextContent("Demo");
    expect(within(windowEl).getByTestId("browser-window-shot")).toBeInTheDocument();
    const rows = screen.getAllByTestId("browser-log-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[2]).toHaveTextContent("打开网页");
  });

  test("默认停在最后一张截图;点操作记录换窗口内容;失败的一步说明没有截图", async () => {
    const messages = session();
    render(<InspectorPanelContent messages={messages} request={{ tab: "browser", message: messages[1], nonce: 1 }} onClose={() => {}} />);
    await browserReady();
    // messages[1] 不是浏览器步:落到这一轮的默认(最后一张截图 = 第 2 步)。
    let rows = screen.getAllByTestId("browser-log-row");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("browser-window-title")).toHaveTextContent("Demo · Saturn");
    fireEvent.click(within(rows[2] as HTMLElement).getAllByRole("button")[0] as HTMLElement);
    rows = screen.getAllByTestId("browser-log-row");
    expect(rows[2]).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("browser-window-noshot")).toHaveTextContent("没有成功");
  });

  test("操作记录里的「详情」进步骤页那一步", async () => {
    const messages = session();
    render(<InspectorPanelContent messages={messages} request={{ tab: "browser", message: messages[2], nonce: 1 }} onClose={() => {}} />);
    await browserReady();
    fireEvent.click(screen.getByRole("button", { name: "第 2 步的详情" }));
    expect(screen.getByRole("tab", { name: /步骤/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 5");
  });

  test("大记录定位桩:用点击带来的完整消息,或页面缓存里的正文", async () => {
    const full = session();
    const stub: ChatMessage = {
      id: "b1",
      role: "tool",
      text: "",
      ts: TS,
      _payloadDeferred: true,
      _turnTapeId: "tape-1",
      _recordOrdinal: 3,
    } as ChatMessage;
    const messages = full.map((m) => (m.id === "b1" ? stub : m));
    const { unmount } = render(
      <InspectorPanelContent messages={messages} request={{ tab: "browser", message: full[2], nonce: 1 }} onClose={() => {}} />,
    );
    await browserReady();
    expect(screen.getByRole("tab", { name: /浏览器/ })).toHaveTextContent("3");
    expect(screen.getAllByTestId("browser-log-row")[0]).toHaveAttribute("aria-current", "true");
    unmount();
    const peek = () => [full[2] as ChatMessage];
    render(
      <InspectorPanelContent
        messages={messages}
        deferredLoader={{ peek }}
        request={{ tab: "browser", message: stub, nonce: 1 }}
        onClose={() => {}}
      />,
    );
    await browserReady();
    expect(screen.getByRole("tab", { name: /浏览器/ })).toHaveTextContent("3");
  });

  describe("大截图定位桩由面板自己补取(OCV5-629:收起的过程不再替面板预取)", () => {
    // 只留第一轮:浏览器步在最新一轮里。b1 / b2 是 >1 MiB 的定位桩(序号 3 / 4),b3 仍是普通行。
    const stub = (id: string, ordinal: number): ChatMessage =>
      ({ id, role: "tool", text: "", ts: TS, _payloadDeferred: true, _turnTapeId: "tape-1", _recordOrdinal: ordinal }) as ChatMessage;
    function stubbed(ids: Record<string, number> = { b1: 3, b2: 4 }) {
      const full = session().slice(0, 6);
      const messages = full.map((m) => (m.id in ids ? stub(m.id, ids[m.id] as number) : m));
      const fetch = vi.fn(async (_tape: string, ordinal: number) => {
        const hit = full.find((m) => ids[m.id] === ordinal);
        return hit ? [hit] : null;
      });
      return { messages, fetch };
    }
    const ordinals = (fetch: ReturnType<typeof stubbed>["fetch"]) => fetch.mock.calls.map((call) => call[1]).sort();

    test("冷加载停在「浏览器」页且这一轮浏览器步全是定位桩:先给读取态、不退回产出,补取后列出", async () => {
      localStorage.setItem(PANE_TAB_STORAGE_KEY, "browser");
      const { messages, fetch } = stubbed({ b1: 3, b2: 4, b3: 5 });
      render(<InspectorPanelContent messages={messages} deferredLoader={{ fetch }} onClose={() => {}} />);
      expect(screen.getByTestId("browser-hydrating")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /浏览器/ })).toHaveAttribute("aria-selected", "true");
      await browserReady();
      expect(screen.queryByTestId("browser-hydrating")).toBeNull();
      expect(screen.getByRole("tab", { name: /浏览器/ })).toHaveTextContent("3");
      expect(screen.getAllByTestId("browser-log-row")).toHaveLength(3);
      expect(ordinals(fetch)).toEqual([3, 4, 5]);
    });

    test("停在产出页:后台补取完成后「浏览器」分区计入大截图步", async () => {
      const { messages, fetch } = stubbed();
      render(<InspectorPanelContent messages={messages} deferredLoader={{ fetch }} onClose={() => {}} />);
      await screen.findByTestId(/^outputs-(view|empty)$/);
      await waitFor(() => expect(screen.getByRole("tab", { name: /浏览器/ })).toHaveTextContent("3"));
      expect(screen.getByRole("tab", { name: /产出/ })).toHaveAttribute("aria-selected", "true");
      expect(ordinals(fetch)).toEqual([3, 4]);
    });

    test("补取失败:每条只取一次、重渲染不重取;取完仍没有浏览器步就退回产出", async () => {
      localStorage.setItem(PANE_TAB_STORAGE_KEY, "browser");
      const { messages } = stubbed({ b1: 3, b2: 4, b3: 5 });
      const fetch = vi.fn(async () => null);
      const { rerender } = render(<InspectorPanelContent messages={messages} deferredLoader={{ fetch }} onClose={() => {}} />);
      await screen.findByTestId(/^outputs-(view|empty)$/);
      expect(screen.queryByTestId("browser-hydrating")).toBeNull();
      expect(screen.queryByRole("tab", { name: /浏览器/ })).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(3);
      rerender(<InspectorPanelContent messages={[...messages]} deferredLoader={{ fetch }} onClose={() => {}} />);
      await screen.findByTestId(/^outputs-(view|empty)$/);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    test("步骤页正在自取的那一条不重复发起,其余定位桩照常补取", async () => {
      const { messages, fetch } = stubbed();
      render(
        <InspectorPanelContent
          messages={messages}
          request={{ tab: "steps", message: messages[2], nonce: 1 }}
          deferredLoader={{ fetch }}
          onClose={() => {}}
        />,
      );
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(ordinals(fetch)).toEqual([3, 4]);
    });
  });

  test("不在顶层轮里的浏览器步(子任务等)退回步骤详情", () => {
    const child = bash("child", "oc-browser open https://a.example", page("https://a.example/", "A"));
    render(<InspectorPanelContent messages={session()} request={{ tab: "browser", message: child, nonce: 1 }} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /步骤/ })).toHaveAttribute("aria-selected", "true");
  });
});
