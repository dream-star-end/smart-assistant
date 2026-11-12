/**
 * UI-2a 详情面板开合(hooks/useDetailPane):默认收起、手动开 / 关记在本机、「产出 N」与产出页同源、
 * 顶栏开关从收起态打开的是产出页、面板本体懒加载后照常挂上。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { latestTurnOutputCount } from "../components/chat/workbench";
import { DetailPane, PANE_OPEN_STORAGE_KEY, useDetailPane } from "./useDetailPane";

const TS = 1_700_000_000_000;
const W = "/home/agent/.openclaude/workspace/s1";
const user = (id: string, text: string): ChatMessage => ({ id, role: "user", text, ts: TS, status: "replied" });
const assistant = (id: string, text: string): ChatMessage => ({ id, role: "assistant", text, ts: TS });
const write = (id: string, path: string): ChatMessage => ({
  id,
  role: "tool",
  text: "Write",
  ts: TS,
  toolName: "Write",
  inputJson: { file_path: path, content: "a\n" },
  _completed: true,
  output: "ok",
});

function withOutputs(): ChatMessage[] {
  return [user("u1", "写两份文件"), write("w1", `${W}/a.md`), write("w2", `${W}/b.html`), assistant("a1", "好了")];
}

/** useWideViewport 读 matchMedia(min-width: 1100px)。 */
function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.includes("1100px"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("latestTurnOutputCount", () => {
  test("只数最新一轮;新一轮还没有产出就是 0", () => {
    const messages = withOutputs();
    expect(latestTurnOutputCount(messages)).toBe(2);
    expect(latestTurnOutputCount([...messages, user("u2", "谢谢")])).toBe(0);
    expect(latestTurnOutputCount([])).toBe(0);
  });
});

describe("useDetailPane", () => {
  const base = { activeId: "s1", inChat: true, demo: false, version: 1 };

  test("默认收起;这一轮有产出时给出 N,顶栏开关打开的是产出页并记住「手动打开过」", async () => {
    viewport(true);
    const { result } = renderHook(() => useDetailPane({ ...base, messages: withOutputs() }));
    expect(result.current.shown).toBe(false);
    await waitFor(() => expect(result.current.outputs).toBe(2));
    act(() => result.current.toggle?.());
    expect(result.current.shown).toBe(true);
    expect(result.current.host.request?.tab).toBe("outputs");
    expect(localStorage.getItem(PANE_OPEN_STORAGE_KEY)).toBe("1");
    act(() => result.current.toggle?.());
    expect(result.current.shown).toBe(false);
    expect(localStorage.getItem(PANE_OPEN_STORAGE_KEY)).toBe("0");
  });

  test("用户手动打开过的保持打开:刷新后、换到没有产出的一轮也照样展开", () => {
    viewport(true);
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, "1");
    const { result } = renderHook(() => useDetailPane({ ...base, messages: [user("u1", "你好"), assistant("a1", "你好")] }));
    expect(result.current.outputs).toBe(0);
    expect(result.current.shown).toBe(true);
  });

  test("窄屏走贴底面板,不写开合记忆;快捷键停在上次的分区", () => {
    viewport(false);
    const { result } = renderHook(() => useDetailPane({ ...base, messages: withOutputs() }));
    act(() => result.current.toggleRef.current?.());
    expect(result.current.shown).toBe(true);
    expect(result.current.host.sheet).toBe(true);
    expect(result.current.host.request?.tab).toBeUndefined();
    expect(localStorage.getItem(PANE_OPEN_STORAGE_KEY)).toBeNull();
  });

  test("没有会话内容 / 不在对话视图 / demo:不给开关,也不数产出", () => {
    viewport(true);
    const empty = renderHook(() => useDetailPane({ ...base, messages: [] }));
    expect(empty.result.current.toggle).toBeUndefined();
    expect(empty.result.current.toggleRef.current).toBeNull();
    const board = renderHook(() => useDetailPane({ ...base, inChat: false, messages: withOutputs() }));
    expect(board.result.current.toggle).toBeUndefined();
    expect(board.result.current.outputs).toBe(0);
    const demo = renderHook(() => useDetailPane({ ...base, demo: true, messages: withOutputs() }));
    expect(demo.result.current.toggle).toBeUndefined();
  });
});

describe("DetailPane", () => {
  function Host({ messages }: { messages: ChatMessage[] }) {
    const pane = useDetailPane({ activeId: "s1", inChat: true, demo: false, messages, version: 1 });
    return <DetailPane pane={pane} sessionKey="s1" messages={messages} version={1} running={false} />;
  }

  test("宽屏且打开过:懒加载的面板挂成内联第三列", async () => {
    viewport(true);
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, "1");
    render(<Host messages={withOutputs()} />);
    expect(await screen.findByTestId("detail-pane")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "调整详情面板宽度" })).toBeInTheDocument();
  });

  test("默认收起时什么都不挂", () => {
    viewport(true);
    render(<Host messages={withOutputs()} />);
    expect(screen.queryByTestId("detail-pane")).toBeNull();
  });
});
