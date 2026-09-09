/**
 * PermissionCard：孤儿待决卡不得再强行弹框。
 *
 * 背景（boss 07-26 实报「为什么反复弹这个问答」）：permission 卡被刻意排除在服务端 tape 之外
 * （persist.ts §⑦），只活在客户端 IndexedDB；而「是否已解决」的权威在 gateway 内存里，受
 * PENDING_PERMISSION_TTL_MS + session 回收约束。断线期间服务端 force-deny 广播的 settled 帧
 * 若没送达（ring 已轮转 / session 已回收），本地就永久留下一张 `_resolved=false` 的卡 ——
 * 此后每次挂载都被「挂载即弹」的 effect 强行打开，形成永久骚扰。
 *
 * 修法：超过服务端 TTL 的未决卡视为孤儿，不再自动弹；但手动回答入口必须保留（fail-safe）。
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/model";
import {
  activeModalRequest,
  reopenPermissionUi,
  setPermissionFullInputFetcher,
  shouldAutoOpenPermission,
} from "../../lib/chat/permissionPopupCoordinator";
import {
  DETACHED_ASK_USER_TTL_MS,
  PENDING_PERMISSION_TTL_MS,
  PermissionCard,
  PermissionPromptHost,
  isAwaitingPermissionPrompt,
  resetPermissionAutoOpenMemory,
} from "./PermissionCard";

afterEach(() => {
  cleanup();
  resetPermissionAutoOpenMemory();
  setPermissionFullInputFetcher(null);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function askMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "p1",
    role: "permission",
    text: "用户问答",
    ts: Date.now() - 1_000,
    requestId: "req-1",
    toolName: "AskUserQuestion",
    inputJson: {
      questions: [
        {
          question: "多人在线的玩法形态选哪种?",
          header: "多人模式",
          options: [{ label: "组队合作割草" }, { label: "PvPvE 竞技" }],
        },
      ],
    },
    _resolved: false,
    ...overrides,
  } as ChatMessage;
}

describe("PermissionCard 自动弹框的存活边界", () => {
  test("未决且在 TTL 内 → 挂载即自动弹（agent 确实还在等,不能不提醒）", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("用户问答", { selector: "h2, h3, [role='heading']" })).toBeInTheDocument();
  });

  test("未决但已超过服务端 TTL → 不再自动弹（孤儿卡,服务端早已 force-deny）", () => {
    render(
      <PermissionCard
        msg={askMsg({ ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // 卡片本身与状态必须仍在 —— 只是不打断用户。
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
  });

  test("孤儿卡仍保留手动回答入口（本地时钟偏差误判时不能锁死用户）", () => {
    render(
      <PermissionCard
        msg={askMsg({ ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("已解决的卡永不自动弹,不受时间影响", () => {
    render(
      <PermissionCard
        msg={askMsg({ _resolved: true, _behavior: "allow", ts: Date.now() - 1_000 })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("durable decision waiting for Master receipt cannot be submitted twice", () => {
    render(
      <PermissionCard
        msg={askMsg({ _controlPending: true })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("正在提交…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });

  test("readOnly surface（管理端会话查看）永不弹框", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("detached ask_user 超过 30min 仍自动弹（24h TTL,换设备回来仍可作答）", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "ask-user:abc123",
          _detachedAskUser: true,
          ts: Date.now() - PENDING_PERMISSION_TTL_MS - 3 * 60 * 60_000,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("detached ask_user 超过 24h 不再自动弹,但手动回答入口仍在", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "ask-user:abc123",
          _detachedAskUser: true,
          ts: Date.now() - DETACHED_ASK_USER_TTL_MS - 60_000,
        })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("PermissionCard 自动弹窗：活提问 vs 历史 vs 重挂", () => {
  test("活提问已展示后重挂不再自动弹，手动入口仍可开", () => {
    const msg = askMsg({ requestId: "req-remount" });
    const { unmount } = render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unmount();

    render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("用户关掉问答后重挂不再自动弹，手动回答仍可用", () => {
    const msg = askMsg({ requestId: "req-dismissed" });
    const { unmount } = render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("历史行 livePrompt=false 永不自动弹，未答仍可点「回答」", () => {
    render(
      <PermissionCard
        msg={askMsg({ requestId: "req-history" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("等待回答…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("活跃提问 livePrompt 仍会自动弹一次", () => {
    render(
      <PermissionCard
        msg={askMsg({ requestId: "req-live-once" })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("已作答卡展示答案摘要且不弹窗", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-answered",
          _resolved: true,
          _behavior: "allow",
          _answers: { "多人在线的玩法形态选哪种?": "组队合作割草" },
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("→ 组队合作割草")).toBeInTheDocument();
    expect(screen.getByText("已提交")).toBeInTheDocument();
  });

  test("不同 requestId 互不影响，各自仍能自动弹一次", () => {
    const first = askMsg({ requestId: "req-a" });
    const { unmount } = render(<PermissionCard msg={first} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unmount();

    render(<PermissionCard msg={askMsg({ requestId: "req-b" })} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("PermissionCard 过期判据 _askUserExpiresAt", () => {
  test("有 _askUserExpiresAt 且已过期 → 不自动弹，优先于新鲜 ts", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-exp-abs",
          ts: Date.now(),
          _askUserExpiresAt: Date.now() - 1000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已过期")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("无 _askUserExpiresAt 的旧数据退回 ts+TTL", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-old-ttl",
          ts: Date.now() - PENDING_PERMISSION_TTL_MS - 60_000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
  });

  test("_askUserExpiresAt 未到点 → 即使 ts 超过 TTL 也不当过期", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-exp-future",
          _detachedAskUser: true,
          ts: Date.now() - DETACHED_ASK_USER_TTL_MS - 60_000,
          _askUserExpiresAt: Date.now() + 60_000,
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("历史过期卡只读展示，不提供作答按钮", () => {
    render(
      <PermissionCard
        msg={askMsg({
          requestId: "req-hist-exp",
          ts: Date.now(),
          _askUserExpiresAt: Date.now() - 1000,
        })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("已过期")).toBeInTheDocument();
    expect(screen.getByText("提问已过期，无法再作答")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回答" })).toBeNull();
  });
});

function bashPermMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "perm-bash",
    role: "permission",
    text: "权限请求",
    ts: Date.now() - 1_000,
    requestId: "req-bash",
    toolName: "Bash",
    inputJson: { command: "npm run build" },
    inputPreview: '{"command":"npm run build"}',
    _resolved: false,
    ...overrides,
  } as ChatMessage;
}

describe("PermissionCard 工具展示(F5/M7)", () => {
  test("工具名走中文标签(Bash→终端),不再裸英文;状态不再用 emoji", () => {
    render(<PermissionCard msg={bashPermMsg()} onRespond={vi.fn()} livePrompt={false} />);
    expect(screen.getByText("终端")).toBeInTheDocument();
    const text = document.body.textContent || "";
    expect(text).not.toContain("⏳");
    expect(text).not.toContain("✓");
    expect(text).not.toContain("✗");
  });

  test("无 toolName → 「未知工具」而非 'unknown'", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ toolName: undefined, inputJson: undefined, inputPreview: undefined })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.getByText("未知工具")).toBeInTheDocument();
    expect(document.body.textContent || "").not.toContain("unknown");
  });

  test("审批 modal:Bash 结构化展示命令,原始 JSON 收进「查看完整参数」折叠", () => {
    render(<PermissionCard msg={bashPermMsg()} onRespond={vi.fn()} livePrompt />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("npm run build");
    expect(screen.getAllByText("查看完整参数").length).toBeGreaterThanOrEqual(1);
    // 窄屏贴底 sheet(mobile="sheet" 的圆角特征类)
    expect(dialog.className).toContain("rounded-t-2xl");
  });

  test("已解决的卡:参数结构化摘要(命令),不再裸 dump inputPreview", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ _resolved: true, _behavior: "allow" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(document.body.textContent || "").toContain("npm run build");
    expect(screen.getByText("已允许")).toBeInTheDocument();
  });

  test("截断 AskUserQuestion 取回完整题目之前不能提交", async () => {
    setPermissionFullInputFetcher(async () => ({
      questions: [{ question: "长问题还在吗？", options: [{ label: "是" }, { label: "否" }] }],
    }));
    const onRespond = vi.fn();
    render(
      <PermissionCard
        msg={askMsg({ _inputTruncated: true, inputJson: {} })}
        onRespond={onRespond}
        livePrompt
      />,
    );
    expect(screen.getByText(/完整问题仍在加载/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByText("长问题还在吗？")).toBeInTheDocument());
    fireEvent.click(screen.getByText("是"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0].updatedInput.answers).toEqual({ "长问题还在吗？": "是" });
    setPermissionFullInputFetcher(null);
  });

  test("Host 两个 pending 只开一个可见 modal，切卡不发 permission_response", async () => {
    const onRespond = vi.fn();
    const one = bashPermMsg({ requestId: "req-one", id: "p-one" });
    const two = bashPermMsg({ requestId: "req-two", id: "p-two" });
    render(
      <PermissionPromptHost messages={[one, two]} onRespond={onRespond} sending />,
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("T3 Host 后台挂载不弹，visibilitychange 回前台才弹出", async () => {
    setDocumentHidden(true);
    render(
      <PermissionPromptHost
        messages={[bashPermMsg({ requestId: "req-bg", id: "p-bg" })]}
        onRespond={vi.fn()}
        sending
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => setDocumentHidden(false));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  test("T3 card-only 回前台不 mark displayed、不占 singleton slot", async () => {
    setDocumentHidden(true);
    render(
      <PermissionCard
        msg={bashPermMsg({ requestId: "req-card-bg" })}
        onRespond={vi.fn()}
        livePrompt
        renderMode="card"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => setDocumentHidden(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(activeModalRequest()).toBeNull();
    expect(shouldAutoOpenPermission({ requestId: "req-card-bg", livePrompt: true })).toBe(true);
    expect(screen.getByRole("button", { name: "审批" })).toBeInTheDocument();
  });

  test("T3 card-only 前台挂载也不自动占 slot，手动入口仍在", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ requestId: "req-card-fg" })}
        onRespond={vi.fn()}
        livePrompt
        renderMode="card"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(activeModalRequest()).toBeNull();
    expect(shouldAutoOpenPermission({ requestId: "req-card-fg", livePrompt: true })).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "审批" }));
    expect(activeModalRequest()).toBe("req-card-fg");
  });

  test("Host 完整短请求切到截断 Ask 在取回前不能盲批", async () => {
    setPermissionFullInputFetcher(() => new Promise(() => {}));
    const onRespond = vi.fn();
    const shortA = bashPermMsg({ requestId: "req-short", id: "p-short" });
    const longB = askMsg({
      id: "p-long",
      requestId: "req-long",
      _inputTruncated: true,
      inputJson: {},
    });
    render(
      <PermissionPromptHost messages={[shortA, longB]} onRespond={onRespond} sending sessionId="sess-a" />,
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "允许" })).toBeInTheDocument();
    reopenPermissionUi("req-long");
    await waitFor(() => expect(screen.getByText(/完整问题仍在加载/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "允许" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("Host 完整短请求切到截断计划在取回前不能确认", async () => {
    setPermissionFullInputFetcher(() => new Promise(() => {}));
    const shortA = bashPermMsg({ requestId: "req-short-plan", id: "p-short-plan" });
    const longPlan = exitPlanMsg({
      id: "p-long-plan",
      requestId: "req-long-plan",
      _inputTruncated: true,
      inputJson: {},
    });
    render(
      <PermissionPromptHost messages={[shortA, longPlan]} onRespond={vi.fn()} sending sessionId="sess-plan" />,
    );
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    reopenPermissionUi("req-long-plan");
    await waitFor(() => expect(screen.getByText(/完整问题仍在加载/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "按此计划执行" })).toBeNull();
  });

  test("Host 切换不同题干不崩溃且提交只作用于当前 request", async () => {
    const onRespond = vi.fn();
    const q1 = askMsg({
      id: "p-q1",
      requestId: "req-q1",
      inputJson: { questions: [{ question: "第一题？", options: [{ label: "甲" }, { label: "乙" }] }] },
    });
    const q2 = askMsg({
      id: "p-q2",
      requestId: "req-q2",
      inputJson: { questions: [{ question: "第二题？", options: [{ label: "丙" }, { label: "丁" }] }] },
    });
    render(
      <PermissionPromptHost messages={[q1, q2]} onRespond={onRespond} sending sessionId="sess-q" />,
    );
    await waitFor(() => expect(screen.getByText("第一题？")).toBeInTheDocument());
    fireEvent.click(screen.getByText("甲"));
    reopenPermissionUi("req-q2");
    await waitFor(() => expect(screen.getByText("第二题？")).toBeInTheDocument());
    expect(screen.queryByText("第一题？")).toBeNull();
    fireEvent.click(screen.getByText("丙"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0].requestId).toBe("req-q2");
    expect(onRespond.mock.calls[0][0].updatedInput.answers).toEqual({ "第二题？": "丙" });
  });

  test("同题干不同 requestId 不继承未提交答案，切换不发 response", async () => {
    const onRespond = vi.fn();
    const a = askMsg({
      id: "p-same-a",
      requestId: "req-same-a",
      inputJson: { questions: [{ question: "同题？", options: [{ label: "左" }, { label: "右" }] }] },
    });
    const b = askMsg({
      id: "p-same-b",
      requestId: "req-same-b",
      inputJson: { questions: [{ question: "同题？", options: [{ label: "左" }, { label: "右" }] }] },
    });
    render(
      <PermissionPromptHost messages={[a, b]} onRespond={onRespond} sending sessionId="sess-same" />,
    );
    await waitFor(() => expect(screen.getByText("同题？")).toBeInTheDocument());
    fireEvent.click(screen.getByText("左"));
    reopenPermissionUi("req-same-b");
    await waitFor(() => expect(screen.getByRole("button", { name: "提交" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("右"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond.mock.calls[0][0].requestId).toBe("req-same-b");
    expect(onRespond.mock.calls[0][0].updatedInput.answers).toEqual({ "同题？": "右" });
  });

  test("mcp 工具名解析为中文标签(打开网页)", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({
          toolName: "mcp__browser__browser_navigate",
          inputJson: { url: "https://example.com" },
          inputPreview: undefined,
        })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    const text = document.body.textContent || "";
    expect(text).not.toContain("mcp__browser__browser_navigate");
    expect(text).toContain("打开网页");
  });
});

function exitPlanMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "p-exit",
    role: "permission",
    text: "退出计划模式",
    ts: Date.now() - 1_000,
    requestId: "req-exit-plan",
    toolName: "ExitPlanMode",
    inputJson: {
      plan: "## 目标\n\n改 PermissionCard，让退出计划弹窗展示 markdown。\n\n1. 修重挂\n2. 渲染计划书",
      planFilePath: "/tmp/plan.md",
    },
    _resolved: false,
    ...overrides,
  } as ChatMessage;
}

describe("ExitPlanMode 计划确认", () => {
  test("活提问自动弹出 markdown 计划书", () => {
    render(<PermissionCard msg={exitPlanMsg()} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("heading", { name: "退出计划模式" })).toBeInTheDocument();
    expect(screen.getByTestId("exit-plan-markdown").textContent).toContain("改 PermissionCard");
    expect(screen.getByRole("button", { name: "按此计划执行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续规划" })).toBeInTheDocument();
  });

  test("关闭只关 UI，不批准不拒绝，卡片可重开", () => {
    const onRespond = vi.fn();
    render(<PermissionCard msg={exitPlanMsg()} onRespond={onRespond} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "审阅计划" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("按此计划执行 → allow", () => {
    const onRespond = vi.fn();
    render(<PermissionCard msg={exitPlanMsg()} onRespond={onRespond} livePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "按此计划执行" }));
    expect(onRespond).toHaveBeenCalledWith({ requestId: "req-exit-plan", behavior: "allow" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("继续规划 → deny", () => {
    const onRespond = vi.fn();
    render(<PermissionCard msg={exitPlanMsg()} onRespond={onRespond} livePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "继续规划" }));
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "req-exit-plan",
      behavior: "deny",
      message: "User rejected the plan",
    });
  });

  test("已展示的计划确认重挂不再自动弹，审阅入口仍可开", () => {
    const msg = exitPlanMsg();
    const { unmount } = render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    unmount();
    render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "审阅计划" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("exit-plan-markdown").textContent).toContain("markdown");
  });

  test("缺少 plan 正文时仍可批准，给出说明", () => {
    render(
      <PermissionCard
        msg={exitPlanMsg({ inputJson: { planFilePath: "/tmp/plan.md" } })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    expect(screen.getByTestId("exit-plan-missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按此计划执行" })).toBeInTheDocument();
  });
});

describe("AskUserQuestion 选项可及性(M12)", () => {
  test("单选题:radiogroup + role=radio + aria-checked 跟随选中", () => {
    render(<PermissionCard msg={askMsg()} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(2);
    const first = screen.getByRole("radio", { name: /组队合作割草/ });
    expect(first).toHaveAttribute("aria-checked", "false");
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-checked", "true");
  });

  test("多选题:group + role=checkbox", () => {
    render(
      <PermissionCard
        msg={askMsg({
          inputJson: {
            questions: [
              {
                question: "选择要启用的能力",
                header: "能力",
                multiSelect: true,
                options: [{ label: "检索" }, { label: "生成" }],
              },
            ],
          },
        })}
        onRespond={vi.fn()}
        livePrompt
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /检索/ }));
    expect(screen.getByRole("checkbox", { name: /检索/ })).toHaveAttribute("aria-checked", "true");
  });
});

describe("isAwaitingPermissionPrompt（INC-20260904 fix C 的活提问判据）", () => {
  const now = Date.now();

  test("未决、未过期、非控制中 → true", () => {
    expect(isAwaitingPermissionPrompt(askMsg(), now)).toBe(true);
  });

  test("非 permission 行 → false", () => {
    expect(isAwaitingPermissionPrompt({ id: "a", role: "assistant", text: "hi", ts: now } as ChatMessage, now)).toBe(false);
  });

  test("已结清 / 控制中 → false", () => {
    expect(isAwaitingPermissionPrompt(askMsg({ _resolved: true, _behavior: "deny" }), now)).toBe(false);
    expect(isAwaitingPermissionPrompt(askMsg({ _controlPending: true }), now)).toBe(false);
  });

  test("超过 TTL 的孤儿卡 → false；_askUserExpiresAt 仍在未来 → true", () => {
    expect(
      isAwaitingPermissionPrompt(askMsg({ ts: now - PENDING_PERMISSION_TTL_MS - 60_000 }), now),
    ).toBe(false);
    expect(
      isAwaitingPermissionPrompt(
        askMsg({ ts: now - PENDING_PERMISSION_TTL_MS - 60_000, _askUserExpiresAt: now + 60_000 }),
        now,
      ),
    ).toBe(true);
  });

  test("user_stop 结清的卡展示「本轮已停止，提问已关闭」且不再弹框", () => {
    render(
      <PermissionCard
        msg={askMsg({ _resolved: true, _behavior: "deny", _settledReason: "user_stop" })}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("本轮已停止，提问已关闭")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("PermissionCard 关掉≠作答（pending-approval-bar）", () => {
  /** overlay 与关闭按钮都走 onOpenChange(false)；jsdom 下 Radix overlay 不一定吞点击，关钮兜底。 */
  function dismissWithoutAnswering() {
    const overlay = document.body.querySelector(".bg-black\\/40");
    if (overlay) {
      fireEvent.pointerDown(overlay);
      fireEvent.click(overlay);
    }
    const closeBtn = screen.queryByRole("button", { name: "关闭" });
    if (closeBtn) fireEvent.click(closeBtn);
  }

  test("overlay 关闭后 bar 出现", () => {
    render(<PermissionCard msg={askMsg({ requestId: "req-bar-overlay" })} onRespond={vi.fn()} livePrompt />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    dismissWithoutAnswering();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("pending-approval-bar")).toBeInTheDocument();
    expect(screen.getByTestId("pending-approval-bar")).toHaveTextContent("智能体在等你确认");
  });

  test("点 bar 重开", () => {
    render(<PermissionCard msg={askMsg({ requestId: "req-bar-reopen" })} onRespond={vi.fn()} livePrompt />);
    dismissWithoutAnswering();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
  });

  test("作答后 bar 消失", () => {
    const onRespond = vi.fn();
    const msg = askMsg({ requestId: "req-bar-answered" });
    const { rerender } = render(<PermissionCard msg={msg} onRespond={onRespond} livePrompt />);
    dismissWithoutAnswering();
    expect(screen.getByTestId("pending-approval-bar")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    fireEvent.click(screen.getByRole("button", { name: "暂不回答，让它继续" }));
    expect(onRespond).toHaveBeenCalled();
    rerender(
      <PermissionCard
        msg={{ ...msg, _resolved: true, _behavior: "deny" }}
        onRespond={onRespond}
        livePrompt
      />,
    );
    expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
  });

  test("未调用 onRespond", () => {
    const onRespond = vi.fn();
    render(<PermissionCard msg={askMsg({ requestId: "req-bar-no-respond" })} onRespond={onRespond} livePrompt />);
    dismissWithoutAnswering();
    expect(screen.getByTestId("pending-approval-bar")).toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });
});

describe("跨包契约", () => {
  // 前端改不动 gateway 常量（那是容器内源码面 / runtime release 轴），只能镜像。数值一旦漂移,
  // 孤儿判定就会与服务端 sweep 错位:偏大 → 骚扰窗口回来;偏小 → 真正在等的 agent 被静默。
  // 断言语义值相等,不锁字面排列（锁排列 = 重构必红 = 红灯贬值）。
  test("前端 TTL 必须等于 gateway 的 PENDING_PERMISSION_TTL_MS", () => {
    // vitest 下 import.meta.url 不是 file: scheme（vite 模块运行时），改从 cwd 向上找仓根 ——
    // CI 从仓根跑、本地从 packages/web-react 跑,两种 cwd 都要成立。
    const rel = join("packages", "gateway", "src", "server.ts");
    let dir = process.cwd();
    let serverPath = "";
    for (let i = 0; i < 6 && !serverPath; i += 1) {
      if (existsSync(join(dir, rel))) serverPath = join(dir, rel);
      else dir = dirname(dir);
    }
    expect(serverPath, `未能从 ${process.cwd()} 向上定位 ${rel}`).toBeTruthy();
    const serverSrc = readFileSync(serverPath, "utf8");
    const matched = /PENDING_PERMISSION_TTL_MS\s*=\s*([0-9_\s*]+)/.exec(serverSrc);
    expect(matched, "gateway 侧 PENDING_PERMISSION_TTL_MS 定义未找到（被改名?）").toBeTruthy();

    // 只支持乘法字面量（当前形态 `30 * 60_000`）。若 gateway 换成别的表达式,这里会红 —— 那是
    // 需要人工确认语义的信号,不是脆断言。
    const factors = matched![1].replace(/_/g, "").split("*").map((s) => Number(s.trim()));
    expect(factors.every((n) => Number.isFinite(n))).toBe(true);
    const serverTtl = factors.reduce((a, b) => a * b, 1);

    expect(serverTtl).toBe(PENDING_PERMISSION_TTL_MS);
  });
});


describe("181 ae57 stable Host pinned entry", () => {
  test("card-only unmount retains Host bar and reopens one dialog without responding", () => {
    const msg = askMsg({ requestId: "host-bar-unmount" });
    const respond = vi.fn();
    const tree = (rows: boolean) => <>
      <div id="pending-approval-bar-slot" />
      <PermissionPromptHost messages={[msg]} onRespond={respond} sending sessionId="bar-session" />
      {rows && <PermissionCard msg={msg} onRespond={respond} renderMode="card" />}
    </>;
    const { rerender } = render(tree(true));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTestId("pending-approval-bar")).toHaveLength(1);
    rerender(tree(false));
    expect(document.getElementById("pending-approval-bar-slot")).toContainElement(screen.getByTestId("pending-approval-bar"));
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  test("same Host session switch does not expose previous minimized request", () => {
    const a = askMsg({ requestId: "host-session-a" });
    const b = askMsg({ requestId: "host-session-b" });
    const respond = vi.fn();
    const { rerender } = render(<PermissionPromptHost messages={[a]} onRespond={respond} sending sessionId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByTestId("pending-approval-bar")).toHaveAttribute("data-request-id", a.requestId);
    rerender(<PermissionPromptHost messages={[b]} onRespond={respond} sending sessionId="b" />);
    expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByTestId("pending-approval-bar")).toHaveAttribute("data-request-id", b.requestId);
    rerender(<PermissionPromptHost messages={[{ ...b, _controlPending: true }]} onRespond={respond} sending sessionId="b" />);
    expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  test("absolute expiry removes minimized bar without a new message frame", () => {
    vi.useFakeTimers();
    try {
      const respond = vi.fn();
      const msg = askMsg({ requestId: "host-expiry", _askUserExpiresAt: Date.now() + 1000 });
      render(<PermissionPromptHost messages={[msg]} onRespond={respond} sending />);
      fireEvent.click(screen.getByRole("button", { name: "关闭" }));
      expect(screen.getByTestId("pending-approval-bar")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1001));
      expect(screen.queryByTestId("pending-approval-bar")).toBeNull();
      expect(respond).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("审批活卡剩余时间", () => {
  test("未决权限卡 header 以 sibling 显示约 N 分钟内有效，且不改「等待审批…」", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ ts: Date.now() - 5 * 60_000, requestId: "req-remain" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    expect(screen.getByText("等待审批…")).toBeInTheDocument();
    expect(screen.getByText("约 25 分钟内有效")).toBeInTheDocument();
    expect(screen.getByText("约 25 分钟内有效")).not.toHaveClass("text-warning");
  });

  test("剩余不足 2 分钟用 warning 色", () => {
    render(
      <PermissionCard
        msg={bashPermMsg({ ts: Date.now() - 29 * 60_000, requestId: "req-remain-urgent" })}
        onRespond={vi.fn()}
        livePrompt={false}
      />,
    );
    const label = screen.getByText("约 1 分钟内有效");
    expect(label).toHaveClass("text-warning");
  });
});

describe("问答跳过语义", () => {
  test("可见文案是暂不回答，payload 仍是 deny + User skipped", () => {
    const onRespond = vi.fn();
    render(<PermissionCard msg={askMsg({ requestId: "req-skip-copy" })} onRespond={onRespond} livePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "暂不回答，让它继续" }));
    expect(onRespond).toHaveBeenCalledWith({
      requestId: "req-skip-copy",
      behavior: "deny",
      message: "User skipped",
    });
  });
});

describe("181 a753 countdown keeps the single expiry authority", () => {
  test("unknown deadline stays answerable without a fictitious infinite countdown", () => {
    const msg = bashPermMsg({ ts: Number.NaN, requestId: "unknown-deadline" });
    render(<PermissionCard msg={msg} onRespond={vi.fn()} livePrompt={false} />);
    expect(permissionHasExpired(msg)).toBe(false);
    expect(screen.getByRole("button", { name: "审批" })).toBeInTheDocument();
    expect(screen.queryByText(/分钟内有效/)).toBeNull();
  });

  test("finite deadline countdown expires without an incoming frame and never responds", () => {
    vi.useFakeTimers();
    try {
      const respond = vi.fn();
      const msg = bashPermMsg({ requestId: "countdown-finite", _askUserExpiresAt: Date.now() + 1500 });
      render(<PermissionCard msg={msg} onRespond={respond} livePrompt={false} />);
      expect(screen.getByText("约 1 分钟内有效")).toHaveClass("text-warning");
      act(() => vi.advanceTimersByTime(2000));
      expect(screen.getByText("已过期")).toBeInTheDocument();
      expect(screen.queryByText(/分钟内有效/)).toBeNull();
      expect(screen.queryByRole("button", { name: "审批" })).toBeNull();
      expect(respond).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
