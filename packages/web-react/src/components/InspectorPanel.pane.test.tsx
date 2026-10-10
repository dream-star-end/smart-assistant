/**
 * OCV5-370 详情面板(右侧第三栏)行为锁:分区、步骤列表与翻步、跟随最新、改动汇总、计划、记忆与焦点。
 * 单步全文 / 复制 / 状态同源见 InspectorPanel.test.tsx。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import {
  InspectorPanel,
  InspectorPanelContent,
  PANE_TAB_STORAGE_KEY,
  paneRequestForSession,
} from "./InspectorPanel";

afterEach(cleanup);
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const TS = 1_700_000_000_000;

function user(id: string, text: string): ChatMessage {
  return { id, role: "user", text, ts: TS, status: "replied" };
}

function tool(id: string, toolName: string, inputJson: Record<string, unknown>, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "tool", text: toolName, ts: TS, toolName, inputJson, _completed: true, output: "ok", ...extra };
}

function session(): ChatMessage[] {
  return [
    user("u1", "第一轮：建目录"),
    tool("t1", "Bash", { command: "mkdir -p demo" }),
    { id: "a1", role: "assistant", text: "好了", ts: TS },
    user("u2", "第二轮：写代码并运行"),
    tool("t2", "Write", { file_path: "/w/demo/fib.py", content: "a\nb\n" }),
    tool("t3", "Bash", { command: "python3 fib.py" }),
    tool("t4", "Write", { file_path: "/w/demo/fib.py", content: "a\nB\nc\n" }),
  ];
}

const STEPS = { tab: "steps" as const, nonce: 1 };

describe("详情面板分区与步骤", () => {
  test("步骤页按轮分组、最近一轮在上并默认展开;点一步进入详情,计数与上一步 / 下一步 / 返回", () => {
    render(<InspectorPanelContent messages={session()} request={STEPS} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /步骤\s*4/ })).toHaveAttribute("aria-selected", "true");
    const turns = screen.getAllByTestId("pane-turn");
    expect(turns).toHaveLength(2);
    expect(within(turns[0]).getByText("第二轮：写代码并运行")).toBeInTheDocument();
    expect(within(turns[0]).getAllByTestId("pane-step")).toHaveLength(3);
    // 更早的轮默认收起,点开才见
    expect(within(turns[1]).queryByTestId("pane-step")).not.toBeInTheDocument();
    fireEvent.click(within(turns[1]).getByRole("button", { name: /第一轮/ }));
    expect(within(turns[1]).getAllByTestId("pane-step")).toHaveLength(1);

    fireEvent.click(within(turns[0]).getAllByTestId("pane-step")[1]);
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 4");
    expect(screen.getByRole("heading", { level: 3, name: "终端" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("下一步"));
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 4");
    expect(screen.getByLabelText("下一步")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("上一步"));
    fireEvent.click(screen.getByLabelText("上一步"));
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("2 / 4");
    fireEvent.click(screen.getByRole("button", { name: /全部步骤/ }));
    expect(screen.getByTestId("pane-step-list")).toBeInTheDocument();
  });

  test("面板内 K/J 与 ←/→ 翻步;焦点在分区栏上时 ←/→ 归分区栏", () => {
    const messages = session();
    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: "steps", message: messages[5], nonce: 1 }}
        onClose={() => {}}
      />,
    );
    const body = screen.getByTestId("pane-step-body");
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 4");
    fireEvent.keyDown(body, { key: "j" });
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 4");
    fireEvent.keyDown(body, { key: "ArrowLeft" });
    fireEvent.keyDown(body, { key: "k" });
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("2 / 4");
    fireEvent.keyDown(screen.getByRole("tab", { name: /步骤/ }), { key: "ArrowRight" });
    expect(screen.queryByTestId("pane-step-counter")).not.toBeInTheDocument();
  });

  test("每步用时与过程时间轴同口径:从上一步结束(首步从本轮开始)到这一步结束", () => {
    const t0 = TS;
    render(
      <InspectorPanelContent
        messages={[
          { ...user("u1", "跑"), ts: t0 },
          { id: "th", role: "thinking", text: "想", ts: t0 + 100, completedAt: t0 + 1000 },
          tool("b1", "Bash", { command: "a" }, { ts: t0 + 1200, completedAt: t0 + 2500, durationMs: 300 }),
          tool("b2", "Bash", { command: "b" }, { ts: t0 + 2600, completedAt: t0 + 4100, durationMs: 1200 }),
        ]}
        request={STEPS}
        onClose={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("pane-step");
    // 2500 − 1000(思考结束) = 1.5 秒;4100 − 2500 = 1.6 秒(不是工具自身的 0.3 / 1.2 秒)
    expect(rows[0]).toHaveTextContent("1.5 秒");
    expect(rows[1]).toHaveTextContent("1.6 秒");
  });

  test("没有步骤时给空态", () => {
    render(<InspectorPanelContent messages={[user("u1", "你好")]} request={STEPS} onClose={() => {}} />);
    expect(screen.getByText("还没有执行步骤")).toBeInTheDocument();
  });

  test("运行中停在最新一步 = 跟随:新步骤到来自动切过去;翻回旧步骤后「回到最新」", () => {
    const messages = session();
    const onActive = vi.fn();
    const { rerender } = render(
      <InspectorPanelContent messages={messages} running request={STEPS} onClose={() => {}} onActiveChange={onActive} />,
    );
    const latestRow = screen.getAllByTestId("pane-step")[2];
    fireEvent.click(latestRow);
    expect(screen.getByTestId("pane-following")).toBeInTheDocument();
    expect(onActive).toHaveBeenLastCalledWith(messages[6]);

    const next = [...messages, tool("t5", "Read", { file_path: "/w/demo/fib.py" }, { _completed: false, output: "" })];
    rerender(<InspectorPanelContent messages={next} running onClose={() => {}} onActiveChange={onActive} />);
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("5 / 5");
    expect(screen.getByRole("heading", { level: 3, name: "读取文件" })).toBeInTheDocument();
    expect(onActive).toHaveBeenLastCalledWith(next[7]);

    fireEvent.click(screen.getByLabelText("上一步"));
    expect(screen.queryByTestId("pane-following")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pane-latest"));
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("5 / 5");
    expect(screen.getByTestId("pane-following")).toBeInTheDocument();

    // 这一轮结束:不再标「跟随中」
    rerender(<InspectorPanelContent messages={next} running={false} onClose={() => {}} onActiveChange={onActive} />);
    expect(screen.queryByTestId("pane-following")).not.toBeInTheDocument();
  });

  test("从卡片点开不在顶层步骤里的消息(团队子任务 / demo):照常显示详情,不出计数", () => {
    const orphan = tool("x", "Bash", { command: "echo hi" });
    render(<InspectorPanelContent messages={session()} request={{ tab: "steps", message: orphan, nonce: 2 }} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 3, name: "终端" })).toBeInTheDocument();
    expect(screen.queryByTestId("pane-step-counter")).not.toBeInTheDocument();
  });
});

describe("产出页里的改动", () => {
  test("文件的改动视图:同会话再次 Write 按与上次写入的 diff 计数并展示;「查看这一步」跳回步骤", async () => {
    render(<InspectorPanelContent messages={session()} request={{ tab: "outputs", nonce: 1 }} onClose={() => {}} />);
    await screen.findByTestId("outputs-view");
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    const row = screen.getByTestId("outputs-file");
    expect(row).toHaveTextContent("fib.py");
    expect(row).toHaveTextContent("2 次改动");
    // 第二轮里:首次写入 +2;再次写入 a,b → a,B,c:+2 −1
    expect(row).toHaveTextContent("+4");
    expect(row).toHaveTextContent("−1");
    fireEvent.click(screen.getByRole("radio", { name: "改动 2" }));
    const changes = screen.getAllByTestId("pane-file-change");
    expect(changes).toHaveLength(2);
    expect(changes[1]).toHaveTextContent("覆盖写入（与上次写入对比）");
    fireEvent.click(within(changes[1]).getByRole("button", { name: "查看这一步" }));
    expect(screen.getByRole("tab", { name: /步骤/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 4");
  });

  test("失败的写入标「有失败」且不计行数", async () => {
    const messages = [
      user("u1", "改"),
      tool("e1", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y" }, { error: true, output: "denied" }),
    ];
    render(<InspectorPanelContent messages={messages} onClose={() => {}} />);
    const row = await screen.findByTestId("outputs-file");
    expect(row).toHaveTextContent("有失败");
    expect(row).toHaveTextContent("+0");
  });
});

describe("计划页与记忆", () => {
  test("有 TodoWrite 才出「计划」分区,取整个会话最近的一份", () => {
    const { rerender } = render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    expect(screen.queryByRole("tab", { name: /计划/ })).not.toBeInTheDocument();
    const withPlan = [
      user("u0", "规划"),
      tool("todo", "TodoWrite", {
        todos: [
          { content: "建目录", status: "completed" },
          { content: "写代码", status: "in_progress", activeForm: "正在写代码" },
          { content: "运行", status: "pending" },
        ],
      }),
      ...session(),
    ];
    rerender(<InspectorPanelContent messages={withPlan} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /计划/ }));
    const plan = screen.getByTestId("pane-plan");
    expect(plan).toHaveTextContent("已完成 1 / 3");
    expect(plan).toHaveTextContent("正在写代码");
  });

  test("分区选择记在本机,下次打开停在同一分区;没记过 / r1 记的「改动」→ 产出", () => {
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /步骤/ }));
    expect(localStorage.getItem(PANE_TAB_STORAGE_KEY)).toBe("steps");
    cleanup();
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /步骤/ })).toHaveAttribute("aria-selected", "true");
    cleanup();
    localStorage.setItem(PANE_TAB_STORAGE_KEY, "changes");
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /改动/ })).not.toBeInTheDocument();
  });

  test("按记忆直接展开的宽屏面板不抢焦点;有拖宽把手(separator)", () => {
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    render(
      <InspectorPanel
        messages={session()}
        onClose={() => {}}
        width={440}
        widthMin={320}
        widthMax={720}
        onResizeStart={() => {}}
        onResizeKeyDown={() => {}}
      />,
    );
    expect(document.activeElement).toBe(composer);
    const handle = screen.getByRole("separator", { name: "调整详情面板宽度" });
    expect(handle).toHaveAttribute("aria-valuenow", "440");
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "440px" });
    rafSpy.mockRestore();
    composer.remove();
  });
});

describe("Codex r1 回归", () => {
  test("切会话:上一个会话发出的请求不交给新会话的面板", () => {
    const req = { tab: "steps" as const, message: tool("t", "Bash", { command: "a" }), nonce: 3, sessionId: "A" };
    expect(paneRequestForSession(req, "A")).toBe(req);
    expect(paneRequestForSession(req, "B")).toBeNull();
    expect(paneRequestForSession(null, "B")).toBeNull();
    expect(paneRequestForSession({ nonce: 1 }, undefined)).not.toBeNull();
  });

  test("选中按 id:历史重载用同 id 的新对象替换后,详情显示新正文,计数与翻步还在", () => {
    const first = session();
    const { rerender } = render(<InspectorPanelContent messages={first} request={STEPS} onClose={() => {}} />);
    fireEvent.click(screen.getAllByTestId("pane-step")[1]);
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 4");
    const reloaded = first.map((m) => (m.id === "t3" ? { ...m, output: "RELOADED-OUTPUT" } : { ...m }));
    rerender(<InspectorPanelContent messages={reloaded} onClose={() => {}} />);
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 4");
    expect(screen.getByTestId("pane-step-body")).toHaveTextContent("RELOADED-OUTPUT");
    expect(screen.getByLabelText("下一步")).not.toBeDisabled();
  });

  test("大记录定位桩:用聊天区同一套取数加载正文;失败给重试", async () => {
    const locator: ChatMessage = {
      id: "big",
      role: "tool",
      text: "",
      ts: TS,
      _payloadDeferred: true,
      _turnTapeId: "tape-1",
      _recordOrdinal: 4,
    };
    const full = tool("big", "Bash", { command: "cat huge.log" }, { output: "HUGE-BODY-LOADED" });
    const fetch = vi.fn().mockResolvedValue([full]);
    render(
      <InspectorPanelContent
        messages={[user("u", "看日志"), locator]}
        request={{ tab: "steps", message: locator, nonce: 1 }}
        deferredLoader={{ fetch }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("pane-deferred-loading")).toBeInTheDocument();
    expect(await screen.findByText(/HUGE-BODY-LOADED/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("tape-1", 4, { recordId: "big", role: "tool" }, expect.any(AbortSignal));
    cleanup();

    const failing = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([full]);
    render(
      <InspectorPanelContent
        messages={[user("u", "看日志"), locator]}
        request={{ tab: "steps", message: locator, nonce: 1 }}
        deferredLoader={{ fetch: failing }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(/HUGE-BODY-LOADED/)).toBeInTheDocument();
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
  });

  test("页面缓存里已有正文(peek)时直接显示,不再取", () => {
    const locator: ChatMessage = { id: "big", role: "tool", text: "", ts: TS, _payloadDeferred: true, _turnTapeId: "t", _recordOrdinal: 1 };
    const fetch = vi.fn();
    render(
      <InspectorPanelContent
        messages={[locator]}
        request={{ tab: "steps", message: locator, nonce: 1 }}
        deferredLoader={{ peek: () => [tool("big", "Bash", { command: "x" }, { output: "PEEKED" })], fetch }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/PEEKED/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("生成中从最新那张卡点开 → 直接跟随;点开旧卡不跟随", () => {
    const messages = session();
    const { rerender } = render(<InspectorPanelContent messages={messages} running onClose={() => {}} />);
    rerender(<InspectorPanelContent messages={messages} running request={{ tab: "steps", message: messages[6], nonce: 5 }} onClose={() => {}} />);
    expect(screen.getByTestId("pane-following")).toBeInTheDocument();
    rerender(<InspectorPanelContent messages={messages} running request={{ tab: "steps", message: messages[4], nonce: 6 }} onClose={() => {}} />);
    expect(screen.queryByTestId("pane-following")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-latest")).toBeInTheDocument();
  });

  test("面板关着时生成中点最新卡:首次挂载就跟随,后续步骤到来自动切过去", () => {
    const messages = session();
    const { rerender } = render(
      <InspectorPanelContent messages={messages} running request={{ tab: "steps", message: messages[6], nonce: 1 }} onClose={() => {}} />,
    );
    expect(screen.getByTestId("pane-following")).toBeInTheDocument();
    const next = [...messages, tool("t5", "Bash", { command: "ls" })];
    rerender(<InspectorPanelContent messages={next} running request={{ tab: "steps", message: messages[6], nonce: 1 }} onClose={() => {}} />);
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("5 / 5");
    // 首次挂载点开的是旧卡:不跟随
    cleanup();
    render(<InspectorPanelContent messages={messages} running request={{ tab: "steps", message: messages[4], nonce: 1 }} onClose={() => {}} />);
    expect(screen.queryByTestId("pane-following")).not.toBeInTheDocument();
  });
});
