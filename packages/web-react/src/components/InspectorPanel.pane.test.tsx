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
import { preloadToolBody } from "./tool/lazyToolBody";
import { loadBeforeAll } from "../test/moduleLoad";

// These tests assert expanded tool bodies synchronously, so the lazy chunk must be loaded first.
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

const STEPS_WITHOUT_MESSAGE = { tab: "steps" as const, nonce: 1 };

describe("详情面板分区与按需单步下钻", () => {
  test("OCV5-844: 顶栏不出现常驻「过程」Tab，无具体步骤的 steps 请求安全回落到产出页", async () => {
    render(<InspectorPanelContent messages={session()} request={STEPS_WITHOUT_MESSAGE} onClose={() => {}} />);
    await screen.findByTestId("outputs-view");
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-step-list")).not.toBeInTheDocument();
  });

  test("按需点入具体步骤进入 StepDetail: 计数、上一步 / 下一步与「返回产出」", async () => {
    const messages = session();
    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: "steps", message: messages[5], nonce: 1 }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 4");
    expect(screen.getByRole("heading", { level: 3, name: "终端" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("下一步"));
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 4");
    expect(screen.getByLabelText("下一步")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("上一步"));
    fireEvent.click(screen.getByLabelText("上一步"));
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("2 / 4");
    fireEvent.click(screen.getByRole("button", { name: /返回产出/ }));
    expect(await screen.findByTestId("outputs-view")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-step-counter")).not.toBeInTheDocument();
  });

  test("面板内 K/J 与 ←/→ 翻步;焦点在分区栏上时 ←/→ 归分区栏并退出单步下钻", () => {
    const messages: ChatMessage[] = [
      user("u0", "规划"),
      tool("todo", "TodoWrite", { todos: [{ content: "写代码", status: "in_progress" }] }),
      ...session(),
    ];
    // session()[5] is messages[7] ("python3 fib.py")
    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: "steps", message: messages[7], nonce: 1 }}
        onClose={() => {}}
      />,
    );
    const body = screen.getByTestId("pane-step-body");
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 5");
    fireEvent.keyDown(body, { key: "j" });
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("5 / 5");
    fireEvent.keyDown(body, { key: "ArrowLeft" });
    fireEvent.keyDown(body, { key: "k" });
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("3 / 5");
    fireEvent.keyDown(screen.getByRole("tab", { name: "产出" }), { key: "ArrowRight" });
    expect(screen.queryByTestId("pane-step-counter")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /计划/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("pane-plan")).toBeInTheDocument();
  });

  test("运行中点开最新一步 = 跟随:新步骤到来自动切过去;翻回旧步骤后「回到最新」", () => {
    const messages = session();
    const onActive = vi.fn();
    const { rerender } = render(
      <InspectorPanelContent
        messages={messages}
        running
        request={{ tab: "steps", message: messages[6], nonce: 1 }}
        onClose={() => {}}
        onActiveChange={onActive}
      />,
    );
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
  test("文件的改动视图:同会话再次 Write 按与上次写入的 diff 计数并展示;「查看这一步」下钻 StepDetail 并可返回产出", async () => {
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
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("4 / 4");
    expect(screen.getByRole("button", { name: /返回产出/ })).toBeInTheDocument();

    // 点击「返回产出」回到产出页
    fireEvent.click(screen.getByRole("button", { name: /返回产出/ }));
    expect(await screen.findByTestId("outputs-view")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
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

  test("OCV5-844: 分区选择记在本机; 旧缓存 \"steps\" / \"changes\" 自动迁移回 \"outputs\"", () => {
    const withPlan = [
      user("u0", "规划"),
      tool("todo", "TodoWrite", { todos: [{ content: "写代码", status: "in_progress" }] }),
      ...session(),
    ];
    render(<InspectorPanelContent messages={withPlan} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /计划/ }));
    expect(localStorage.getItem(PANE_TAB_STORAGE_KEY)).toBe("plan");
    cleanup();

    render(<InspectorPanelContent messages={withPlan} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /计划/ })).toHaveAttribute("aria-selected", "true");
    cleanup();

    // 旧缓存 "steps" 静默迁回 "outputs"
    localStorage.setItem(PANE_TAB_STORAGE_KEY, "steps");
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "产出" })).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem(PANE_TAB_STORAGE_KEY)).toBe("outputs");
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    cleanup();

    // r1 旧缓存 "changes" 同样回落到 "outputs"
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
    const handle = screen.getByRole("separator", { name: "调整工作台宽度" });
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
    const { rerender } = render(
      <InspectorPanelContent messages={first} request={{ tab: "steps", message: first[5], nonce: 1 }} onClose={() => {}} />,
    );
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
    fireEvent.click(await screen.findByRole("button", { name: "重新加载" }));
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

  test("OCV5-844: 按需 StepDetail 头部副摘要剥离 env HOME 宿主桥接噪音，顶栏无常驻「过程」Tab", () => {
    const hostCmd = [
      "env HOME=/home/agent /home/agent/.local/bin/host '",
      '  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*"',
      "  set -euo pipefail",
      "  cd /var/lib/docker/volumes/oc-v5-data-u3/_data/workspace/ocv5-832-codex-redesign",
      "  ../../node_modules/.bin/tsc --noEmit",
      "'",
    ].join("\n");
    const messages: ChatMessage[] = [
      user("u1", "🚨 发版主工作树无法快进到 origin tip 7734e3a01b2c3d4e"),
      tool("t1", "Bash", { command: "git status -s" }),
      user("u2", "🎫 lease ls-20261121T072712Z-c88785cc5d71 已满足"),
      tool("t2", "Bash", { command: hostCmd }),
    ];
    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: "steps", message: messages[3], nonce: 1 }}
        onClose={() => {}}
      />,
    );

    // 顶栏不再显示常驻「过程 / 步骤」Tab
    expect(screen.queryByRole("tab", { name: /过程|步骤/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-step-counter")).toHaveTextContent("2 / 2");

    // StepHeader 副摘要已剥离 env HOME=/home/agent 宿主桥接噪音
    const heading = screen.getByRole("heading", { level: 3, name: "终端" });
    const headerRow = heading.closest("div")?.parentElement;
    expect(headerRow).toHaveTextContent("tsc --noEmit");
    expect(headerRow).not.toHaveTextContent("env HOME=");
    expect(headerRow).not.toHaveTextContent("GIT_CONFIG_COUNT");
  });
});
