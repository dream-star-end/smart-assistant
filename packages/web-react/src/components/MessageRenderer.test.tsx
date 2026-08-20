import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { applyServerIncremental } from "../lib/persist";
import { messageSignature } from "../lib/chat/render";
import { MessageList, MessageRenderer } from "./MessageRenderer";
import { resetPermissionAutoOpenMemory, type PermissionRespond } from "./chat/PermissionCard";
import { ResponseRatingProvider } from "./chat/ResponseRating";
import type { CardCallbacks } from "./chat/cards";
import {
  THINKING_HEADLINES_ONLY,
  THINKING_MULTI_SEGMENT,
} from "./tool/__fixtures__/sessionToolTexts";
import { ChatInteractionContext, ToolCardActionsContext } from "./tool/context";

afterEach(() => {
  cleanup();
  resetPermissionAutoOpenMemory();
});

beforeAll(async () => {
  // MarkdownImpl 是 React.lazy 的重 chunk。全量并行时首次 transform/import 偶尔会耗尽
  // RTL 统一的 5s 查询窗口；测试先显式等模块就绪，再让 findBy* 只等待 React 提交 DOM。
  // 冷态 Suspense fallback 由 Markdown.test.tsx 的永久 suspend 替身独立覆盖。
  await import("./MarkdownImpl");
});

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role, text: "", ts: 1000, ...extra };
  // ⚠️ 默认 ts=1000 是 1970 年。permission 卡的自动弹框有存活上界
  // （PermissionCard 的 PENDING_PERMISSION_TTL_MS：超过服务端 TTL 的未决卡按孤儿处理、
  // 不再自动弹），所以待审批用例必须显式给一个新鲜 ts,否则测的就不是真实场景。
}

function renderMsg(
  message: ChatMessage,
  opts: {
    isLast?: boolean;
    sending?: boolean;
    inActiveTurn?: boolean;
    cb?: CardCallbacks;
    onRespond?: PermissionRespond;
    readOnly?: boolean;
  } = {},
) {
  const isLast = opts.isLast ?? true;
  const sending = opts.sending ?? false;
  return render(
    <MessageRenderer
      message={message}
      sig={messageSignature(message, { isLast, sending })}
      isLast={isLast}
      sending={sending}
      inActiveTurn={opts.inActiveTurn ?? true}
      cb={opts.cb ?? {}}
      onRespondPermission={opts.onRespond ?? (() => {})}
      readOnly={opts.readOnly}
    />,
  );
}

describe("MessageRenderer 角色分派 + 非工具卡", () => {
  test("assistant：渲染 markdown 正文（懒加载 chunk 解析后富文本生效）", async () => {
    renderMsg(mk("assistant", { text: "你好**世界**" }));
    // Markdown 经 React.lazy 异步加载：占位期渲染纯文本整段「你好**世界**」。
    // 用精确匹配「世界」跳过占位（占位无独立「世界」节点），等到真正的富文本解析完成，
    // 届时 **世界** 被渲染为 <strong>世界</strong> —— 既验证内容到位，又验证懒加载边界确实落地。
    const strong = await screen.findByText("世界");
    expect(strong.tagName).toBe("STRONG");
  });

  test("已挂载 Bash 卡在相同 totalBytes 的后序 tail 到达时刷新真实正文", () => {
    const before = mk("tool", {
      id: "bash-tail-memo",
      toolName: "Bash",
      inputJson: { command: "long-running-command" },
      _completed: true,
      bashTail: { tail: "旧后台输出", totalBytes: 42, truncatedHead: false },
    });
    const view = renderMsg(before);
    fireEvent.click(screen.getByRole("button", { name: /终端/ }));
    expect(document.body.textContent).toContain("旧后台输出");

    const after: ChatMessage = {
      ...before,
      bashTail: { tail: "新后台输出", totalBytes: 42, truncatedHead: true },
    };
    view.rerender(
      <MessageRenderer
        message={after}
        sig={messageSignature(after, { isLast: true, sending: false })}
        isLast
        sending={false}
        inActiveTurn
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(document.body.textContent).not.toContain("旧后台输出");
    expect(document.body.textContent).toContain("新后台输出");
  });

  test("已挂载 Write 卡按 structured input revision 实时刷新同一张 diff", () => {
    const tool = mk("tool", {
      id: "live-write-snapshot",
      toolName: "Write",
      _partial: true,
      _inputRevision: 1,
      inputJson: {
        file_path: "/tmp/live.txt",
        kind: "add",
        changes: [{ path: "/tmp/live.txt", kind: { type: "add" }, diff: "LINE-0001" }],
      },
    });
    const view = renderMsg(tool, { sending: true });
    expect(document.body.textContent).toContain("LINE-0001");
    expect(screen.getAllByText("写入文件")).toHaveLength(1);

    tool.inputJson = {
      file_path: "/tmp/live.txt",
      kind: "add",
      changes: [{
        path: "/tmp/live.txt",
        kind: { type: "add" },
        diff: "LINE-0001\nLINE-0002",
      }],
    };
    tool._inputRevision = 2;
    view.rerender(
      <MessageRenderer
        message={tool}
        sig={messageSignature(tool, { isLast: true, sending: true })}
        isLast
        sending
        inActiveTurn
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );

    expect(document.body.textContent).toContain("LINE-0002");
    expect(screen.getAllByText("写入文件")).toHaveLength(1);
  });

  test("assistant：超长终态正文逐段挂载且最终字符可达", () => {
    const marker = "EXACT_ASSISTANT_FINAL_MARKER";
    renderMsg(mk("assistant", { text: `${"x".repeat(270_000)}${marker}` }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: "继续显示正文" }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: "继续显示正文" }));
    expect(document.body.textContent).toContain(marker);
  });

  test("assistant：超长流式正文保留最新真实尾部，同时惰性挂载中段", async () => {
    const middle = "EXACT_STREAM_MIDDLE_MARKER";
    const tail = "EXACT_STREAM_LIVE_TAIL";
    const text = `${"h".repeat(160_000)}${middle}${"t".repeat(160_000)}${tail}`;
    renderMsg(mk("assistant", { text }), { sending: true, isLast: true });
    await waitFor(() => expect(document.body.textContent).toContain(tail));
    expect(document.body.textContent).not.toContain(middle);
    fireEvent.click(screen.getByRole("button", { name: /继续显示中间正文/ }));
    expect(document.body.textContent).toContain(middle);
    expect(document.body.textContent).toContain(tail);
  });

  test("thinking：超长真实思考展开后逐段挂载且最终字符可达", () => {
    const marker = "EXACT_THINKING_FINAL_MARKER";
    renderMsg(mk("thinking", { text: `${"r".repeat(270_000)}${marker}` }));
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: "继续显示正文" }));
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: "继续显示正文" }));
    expect(document.body.textContent).toContain(marker);
  });

  test("assistant：余额不足错误卡含「去充值」CTA，点击触发 onTopUp", () => {
    const onTopUp = vi.fn();
    renderMsg(mk("assistant", { _errorCode: "insufficient_credits", _errorDetail: "shortfall 120" }), {
      cb: { onTopUp },
    });
    expect(screen.getByText("积分余额不足")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /去充值/ }));
    expect(onTopUp).toHaveBeenCalledTimes(1);
  });

  test("assistant：权威过期用温和免单卡，隐藏原始 JSON 并可重试", () => {
    const onRegenerate = vi.fn();
    const raw = '{"error":{"code":"MODEL_AUTHORITY_INVALID","status":403,"message":"forbidden"}}';
    const { container } = renderMsg(mk("assistant", {
      text: raw,
      _errorCode: "ENGINE_ERROR",
      _errorDetail: raw,
      usage: { waived: true },
    }), { cb: { onRegenerate } });
    expect(screen.getByText("本轮已自动免单")).toBeInTheDocument();
    expect(screen.getByText(/已发送站内信说明/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/MODEL_AUTHORITY_INVALID|forbidden|403/);
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  test("assistant：截断 banner 含「继续」，点击触发 onContinue", () => {
    const onContinue = vi.fn();
    renderMsg(mk("assistant", { text: "半句话", _truncated: "max_tokens" }), {
      isLast: true,
      sending: false,
      cb: { onContinue },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test("assistant：空轮提示", () => {
    renderMsg(mk("assistant", { _emptyTurn: true }));
    expect(screen.getByText(/没有产生新内容/)).toBeInTheDocument();
  });

  test("assistant：触屏动作按钮保留 44px 命中区，复制与重新生成能力不减少", () => {
    const onRegenerate = vi.fn();
    renderMsg(mk("assistant", { text: "可复制的回答" }), { cb: { onRegenerate } });
    const copy = screen.getByRole("button", { name: "复制" });
    const plain = screen.getByRole("button", { name: "复制纯文本" });
    const regenerate = screen.getByRole("button", { name: "重新生成" });
    for (const button of [copy, plain, regenerate]) {
      expect(button).toHaveClass("[@media(hover:none)]:size-11");
    }
    fireEvent.click(regenerate);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  test("user：气泡 + 状态角标", () => {
    renderMsg(mk("user", { text: "提问", status: "sent" }));
    expect(screen.getByText("提问")).toBeInTheDocument();
    expect(screen.getByText("已送达")).toBeInTheDocument();
  });

  test("thinking：流式态使用稳定的「思考过程」标题并展开", () => {
    renderMsg(mk("thinking", { text: "推理中..." }), { isLast: true, sending: true });
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("推理中...")).toBeInTheDocument();
  });

  test("用户时间线不暴露原始思考 JSON 入口，真实思考正文仍完整可见", () => {
    const marker = "EXACT_VISIBLE_THINKING_BODY";
    renderMsg(mk("thinking", {
      id: "thinking-no-raw",
      text: marker,
      _turnTapeId: "tape-thinking",
      _turnTapeComplete: true,
      _eventHistory: [{ internal: "RAW_THINKING_JSON_MUST_NOT_BE_A_UI_ENTRY" }],
    }));
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText(marker)).toBeInTheDocument();
    expect(screen.queryByText(/查看原始思考记录/)).toBeNull();
    expect(document.body.textContent).not.toContain("RAW_THINKING_JSON_MUST_NOT_BE_A_UI_ENTRY");
  });

  test("thinking：完成态截断标题保留完整悬浮文本", () => {
    renderMsg(mk("thinking", { text: "**这是一个很长的完整思考摘要标题**\n正文" }));
    expect(screen.getByTitle("已思考 · 这是一个很长的完整思考摘要标题")).toBeInTheDocument();
  });

  test("plan：活跃段 + 本轮进行中 → structured steps 交给 PinnedTaskTracker，inline 不重复渲染", () => {
    const { container } = renderMsg(
      mk("plan", {
        text: "计划",
        steps: [
          { step: "第一步", status: "completed" },
          { step: "第二步", status: "inProgress" },
        ],
      }),
      { inActiveTurn: true, sending: true },
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByText("第一步")).toBeNull();
    expect(screen.queryByText("第二步")).toBeNull();
  });

  test("plan：历史段 structured steps 渲染只读 PlanCard(翻历史可见当时计划)", () => {
    renderMsg(
      mk("plan", {
        text: "计划",
        steps: [
          { step: "第一步", status: "completed" },
          { step: "第二步", status: "inProgress" },
        ],
      }),
      { inActiveTurn: false, sending: false },
    );
    expect(screen.getByText("第一步")).toBeInTheDocument();
    expect(screen.getByText("第二步")).toBeInTheDocument();
    expect(screen.getByTitle("计划")).toHaveClass("min-w-0", "flex-1", "truncate");
  });

  test("plan：活跃段但本轮已结束(sending=false,HUD 已隐藏)→ 渲染只读卡兜底", () => {
    renderMsg(mk("plan", { text: "计划", steps: [{ step: "第一步", status: "pending" }] }), {
      inActiveTurn: true,
      sending: false,
    });
    expect(screen.getByText("第一步")).toBeInTheDocument();
  });

  test("plan：text-only 仍渲染 inline 兜底", () => {
    renderMsg(mk("plan", { text: "计划", explanation: "先说明后执行" }));
    expect(screen.getByText("计划")).toBeInTheDocument();
    expect(screen.getByText("先说明后执行")).toBeInTheDocument();
  });

  test("system：居中提示", () => {
    renderMsg(mk("system", { text: "会话已恢复" }));
    const notice = screen.getByText("会话已恢复");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveClass("max-w-full", "break-words", "rounded-xl");
  });

  test("goal → 渲染原生目标更新卡", () => {
    renderMsg(mk("goal", {
      text: "目标",
      goalStatus: "active",
      tokensUsed: 120,
      tokenBudget: 1_000,
      timeUsedSeconds: 8,
    }));
    expect(screen.getByText("目标")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Token 120 / 1,000 · 8s")).toBeInTheDocument();
  });
});

describe("tool / agent-group 集成", () => {
  test("tool role → 委托 ToolCard 渲染（完成态）", () => {
    renderMsg(mk("tool", { toolName: "Bash", inputJson: { command: "ls" }, _completed: true, output: "x" }));
    expect(screen.getByText("完成")).toBeInTheDocument();
  });

  test("历史持久化的微博 confirmation_required Bash 工具行恢复为可操作确认卡", async () => {
    const confirmationId = "315bfd38-7d9f-4a69-8e74-6d34e52aad50";
    const message = mk("tool", {
      id: "persisted-weibo-confirmation",
      toolName: "Bash",
      inputJson: {
        command: `echo '{"text":"测试微博"}' | oc-plugin call weibo create_post 2>&1`,
      },
      output: `${JSON.stringify({
        oc_connect: { type: "confirmation_required", id: confirmationId },
      })}\n写操作需要确认`,
      error: false,
      _completed: true,
    });
    const getDetail = vi.fn().mockResolvedValue({
      id: confirmationId,
      provider: "weibo",
      action: "create_post",
      summary: "发布微博：测试微博",
      detail: { text: "测试微博" },
      status: "pending",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    const decide = vi.fn();
    const sendUserText = vi.fn();
    const { container } = render(
      <ToolCardActionsContext.Provider value={{ connectorConfirm: { getDetail, decide } }}>
        <ChatInteractionContext.Provider value={{ sendUserText }}>
          <MessageRenderer
            message={message}
            sig={messageSignature(message, { isLast: true, sending: false })}
            isLast
            sending={false}
            inActiveTurn={false}
            cb={{}}
            onRespondPermission={() => {}}
          />
        </ChatInteractionContext.Provider>
      </ToolCardActionsContext.Provider>,
    );

    expect(await screen.findByText("写操作待确认 · 发布微博")).toBeInTheDocument();
    expect(screen.getByText("发布微博：测试微博")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled());
    expect(getDetail).toHaveBeenCalledWith(confirmationId);
    expect(container.textContent).not.toContain("oc_connect");
    expect(container.textContent).not.toContain("oc-plugin call");
  });

  const TODO_TOOL = () =>
    mk("tool", {
      toolName: "TodoWrite",
      inputJson: {
        todos: [
          { content: "步骤一", status: "completed" },
          { content: "步骤二", status: "pending" },
        ],
      },
      _completed: true,
    });

  test("TodoWrite：活跃段 + 本轮进行中 → 抑制 inline(HUD 接管)", () => {
    const { container } = renderMsg(TODO_TOOL(), { inActiveTurn: true, sending: true });
    expect(container.textContent).toBe("");
  });

  test("TodoWrite：历史段渲染只读紧凑卡(含步骤与完成状态)", () => {
    renderMsg(TODO_TOOL(), { inActiveTurn: false, sending: false });
    expect(screen.getByText("任务列表")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // 展开可见各步骤与状态
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("步骤一")).toBeInTheDocument();
    expect(screen.getByText("步骤二")).toBeInTheDocument();
  });

  test("TodoWrite：活跃段但本轮已结束(HUD 已隐藏)→ 渲染只读卡兜底", () => {
    renderMsg(TODO_TOOL(), { inActiveTurn: true, sending: false });
    expect(screen.getByText("任务列表")).toBeInTheDocument();
  });

  test("agent-group → 折叠头 + 运行中 + 递归子块（文本）", () => {
    renderMsg(
      mk("agent-group", {
        text: "子任务A",
        _completed: false,
        childBlocks: [{ kind: "text", text: "子代理输出" }],
      }),
    );
    expect(screen.getByText("子任务A")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    // 运行中默认展开 → 子块文本可见。
    expect(screen.getByText("子代理输出")).toBeInTheDocument();
  });

  test("delegate-progress fallback renders child tool blocks with ToolCard", () => {
    renderMsg(
      mk("delegate-progress", {
        _completed: false,
        childBlocks: [
          { kind: "tool_use", blockId: "child-bash", toolName: "Bash", inputJson: { command: "pwd" }, _completed: false },
        ],
      }),
    );
    expect(screen.getByText("委派子任务")).toBeInTheDocument();
    expect(screen.getByText("终端")).toBeInTheDocument();
    expect(screen.getAllByText("pwd").length).toBeGreaterThanOrEqual(1);
  });

  test("delegate-progress fallback keeps final summary when child blocks exist（完成默认折叠，展开见子块）", () => {
    renderMsg(
      mk("delegate-progress", {
        _completed: true,
        summary: "委派最终结果",
        childBlocks: [
          { kind: "tool_use", blockId: "child-bash", toolName: "Bash", inputJson: { command: "pwd" }, _completed: true },
        ],
      }),
    );
    // 完成态默认折叠：摘要在折叠页脚可见，子块暂隐藏。
    expect(screen.getByText("委派最终结果")).toBeInTheDocument();
    expect(screen.queryByText("终端")).toBeNull();
    // 点击头部展开 → 子工具卡可见。
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("终端")).toBeInTheDocument();
  });

  test("delegate-progress：点击头部折叠/展开（进行中默认展开）", () => {
    renderMsg(
      mk("delegate-progress", {
        _completed: false,
        childBlocks: [
          { kind: "tool_use", blockId: "child-bash", toolName: "Bash", inputJson: { command: "pwd" }, _completed: false },
        ],
      }),
    );
    // 进行中默认展开 → 子块可见。
    expect(screen.getByText("终端")).toBeInTheDocument();
    // 点击头部（进行中态此时有头部 + 子工具卡两个 button，取首个=头部）收起。
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.queryByText("终端")).toBeNull();
    // 再点头部展开。
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("终端")).toBeInTheDocument();
  });

  test("delegate-progress fallback keeps legacy entries when child blocks exist", () => {
    renderMsg(
      mk("delegate-progress", {
        _completed: false,
        entries: [{ phase: "text", text: "legacy output", ts: 1 }],
        childBlocks: [
          { kind: "tool_use", blockId: "child-bash", toolName: "Bash", inputJson: { command: "pwd" }, _completed: false },
        ],
      }),
    );
    expect(screen.getByText("legacy output")).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(screen.getByText("终端")).toBeInTheDocument();
  });

  test("delegate-progress entries 按批挂载但可以看到从第一条到最后一条", () => {
    renderMsg(
      mk("delegate-progress", {
        _completed: false,
        entries: Array.from({ length: 205 }, (_, index) => ({
          phase: "text",
          text: `delegate-entry-${index}`,
          ts: index,
        })),
      }),
    );

    expect(screen.getByText("delegate-entry-0")).toBeInTheDocument();
    expect(screen.queryByText("delegate-entry-100")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /继续加载委派记录/ }));
    expect(screen.getByText("delegate-entry-100")).toBeInTheDocument();
    expect(screen.queryByText("delegate-entry-204")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /继续加载委派记录/ }));
    expect(screen.getByText("delegate-entry-204")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /继续加载委派记录/ })).not.toBeInTheDocument();
  });
});

describe("permission 审批", () => {
  test("已允许（普通工具）→ 状态展示", () => {
    renderMsg(mk("permission", { toolName: "Bash", requestId: "r1", _resolved: true, _behavior: "allow" }));
    expect(screen.getByText("已允许")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  test("待审批普通工具 → 自动弹审批框，允许经 onRespondPermission 回送", () => {
    const onRespond = vi.fn();
    renderMsg(mk("permission", { toolName: "Bash", requestId: "r1", _resolved: false, inputPreview: "ls -la", ts: Date.now() }), {
      onRespond,
      sending: true,
    });
    // 自动弹出的 modal（Radix portal）含「允许」。
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(onRespond).toHaveBeenCalledWith({ requestId: "r1", behavior: "allow" });
  });

  test("只读 surface 的待审批工具只展示历史状态，不弹框也不提供写动作", () => {
    const onRespond = vi.fn();
    renderMsg(
      mk("permission", {
        toolName: "Bash",
        requestId: "r-readonly",
        _resolved: false,
        inputPreview: "rm -rf /tmp/example",
        ts: Date.now(),
      }),
      { onRespond, readOnly: true },
    );
    expect(screen.getByText("等待审批…")).toBeInTheDocument();
    expect(screen.getByText(/只读查看/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "审批" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "允许" })).not.toBeInTheDocument();
    expect(screen.queryByText("工具权限请求")).not.toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("AskUserQuestion → 答题框，选项提交回送 updatedInput.answers", () => {
    const onRespond = vi.fn();
    renderMsg(
      mk("permission", {
        toolName: "AskUserQuestion",
        ts: Date.now(),
        requestId: "r2",
        _resolved: false,
        inputJson: {
          questions: [{ question: "选择颜色？", options: [{ label: "红" }, { label: "蓝" }] }],
        },
      }),
      { onRespond, sending: true },
    );
    // 自动弹出答题框（modal portal）。
    expect(screen.getByText("选择颜色？")).toBeInTheDocument();
    fireEvent.click(screen.getByText("红"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    const arg = onRespond.mock.calls[0][0];
    expect(arg.requestId).toBe("r2");
    expect(arg.behavior).toBe("allow");
    expect(arg.updatedInput.answers).toEqual({ "选择颜色？": "红" });
  });

  test("非 in-flight 历史权限行不自动弹，卡片仍在且可手动打开", () => {
    const onRespond = vi.fn();
    renderMsg(
      mk("permission", {
        toolName: "AskUserQuestion",
        ts: Date.now(),
        requestId: "r-history",
        _resolved: false,
        inputJson: {
          questions: [{ question: "选择颜色？", options: [{ label: "红" }, { label: "蓝" }] }],
        },
      }),
      { onRespond, sending: false, inActiveTurn: true },
    );
    expect(screen.getByTestId("permission-card")).toBeInTheDocument();
    expect(screen.getByText("等待回答…")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "回答" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onRespond).not.toHaveBeenCalled();
  });

  test("AskUserQuestion 已提交 → 展示问答摘要", () => {
    renderMsg(
      mk("permission", {
        toolName: "AskUserQuestion",
        requestId: "r3",
        _resolved: true,
        _behavior: "allow",
        _answers: { "选择颜色？": "蓝" },
        inputJson: { questions: [{ question: "选择颜色？", options: [{ label: "红" }, { label: "蓝" }] }] },
      }),
    );
    expect(screen.getByText("→ 蓝")).toBeInTheDocument();
  });
});

describe("MessageList 失败轮单一错误出口", () => {
  const failedUser = mk("user", {
    id: "u-paired-error",
    text: "你是什么模型",
    status: "error",
  });

  test("可见助手错误卡接管失败说明与重试，用户行不重复展示", () => {
    const onRetrySend = vi.fn();
    const messages = [
      failedUser,
      mk("assistant", {
        id: "a-paired-error",
        _clientMessageId: failedUser.id,
        _errorCode: "codex_route_unavailable",
        _errorDetail: "",
      }),
    ];
    render(
      <MessageList
        messages={messages}
        sending={false}
        cb={{
          onRetrySend,
          resolveRetryTarget: (id) => id === failedUser.id ? failedUser : undefined,
        }}
        onRespondPermission={() => {}}
      />,
    );

    expect(screen.getByText("你是什么模型")).toBeInTheDocument();
    expect(screen.queryByText("发送失败")).toBeNull();
    const retries = screen.getAllByRole("button", { name: "重试" });
    expect(retries).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("模型服务暂时不可用");
    expect(document.body).not.toHaveTextContent("GPT");
    expect(screen.queryByText("查看请求信息")).toBeNull();

    fireEvent.click(retries[0]);
    expect(onRetrySend).toHaveBeenCalledTimes(1);
    expect(onRetrySend).toHaveBeenCalledWith(failedUser);
  });

  test("没有可见错误卡的 transport-only 失败仍保留用户行重试", () => {
    render(
      <MessageList
        messages={[failedUser]}
        sending={false}
        cb={{ onRetrySend: vi.fn() }}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("发送失败")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重试" })).toHaveLength(1);
  });

  test("自动恢复最终耗尽时把隐藏 child 的错误归回可见原问题", () => {
    const recoveryChild = mk("user", {
      id: "u-hidden-recovery-child",
      text: "AUTO_RECOVERY_CONTROL_ROW",
      status: "error",
      _isAutoRetry: true,
      _automaticRecovery: true,
      _recoveryOfClientMessageId: failedUser.id,
    });
    const onRetrySend = vi.fn();
    render(
      <MessageList
        messages={[
          failedUser,
          mk("assistant", {
            id: "a-intermediate-recovery-error",
            _clientMessageId: failedUser.id,
            _errorCode: "model_capacity",
          }),
          recoveryChild,
          mk("assistant", {
            id: "a-final-recovery-error",
            _clientMessageId: recoveryChild.id,
            _errorCode: "codex_route_unavailable",
          }),
        ]}
        sending={false}
        cb={{
          onRetrySend,
          resolveRetryTarget: (id) => id === recoveryChild.id ? recoveryChild : undefined,
        }}
        onRespondPermission={() => {}}
      />,
    );

    expect(screen.getByText("你是什么模型")).toBeInTheDocument();
    expect(screen.queryByText("AUTO_RECOVERY_CONTROL_ROW")).toBeNull();
    expect(screen.queryByText("发送失败")).toBeNull();
    const retries = screen.getAllByRole("button", { name: "重试" });
    expect(retries).toHaveLength(1);
    fireEvent.click(retries[0]);
    expect(onRetrySend).toHaveBeenCalledWith(recoveryChild);
  });
});

describe("MessageList 每张调用卡 token 实时展示", () => {
  test("思考和工具卡只显示自己的调用消耗，最终助手保留本轮快照", () => {
    const messages: ChatMessage[] = [
      mk("user", { id: "u-live-token", text: "继续" }),
      mk("thinking", {
        id: "th-live-token",
        text: "分析中",
        _callUsage: {
          callId: "a1-ccb-1",
          targetIds: ["th-live-token"],
          usage: { totalTokens: 64 },
        },
      }),
      mk("tool", {
        id: "tool-live-token",
        toolName: "Bash",
        inputJson: { command: "pwd" },
        _completed: false,
        _callUsage: {
          callId: "a1-ccb-2",
          targetIds: ["tool-live-token"],
          usage: { totalTokens: 128 },
        },
      }),
      mk("assistant", { id: "a-live-token", text: "阶段结果" }),
      mk("plan", { id: "plan-live-token", text: "下一步计划" }),
    ];
    const view = render(
      <MessageList
        messages={messages}
        sending
        liveTurnUsage={{
          clientMessageId: "u-live-token",
          usage: { totalTokens: 256 },
        }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("256")).toBeInTheDocument();

    messages[2]._callUsage = {
      callId: "a1-ccb-2",
      targetIds: ["tool-live-token"],
      usage: { totalTokens: 2_048 },
    };
    view.rerender(
      <MessageList
        messages={messages}
        sending
        liveTurnUsage={{
          clientMessageId: "u-live-token",
          usage: { totalTokens: 512 },
        }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("2.05k")).toBeInTheDocument();
    expect(screen.queryByText("128")).not.toBeInTheDocument();
    expect(screen.getByText("512")).toBeInTheDocument();
    expect(screen.queryByText("256")).not.toBeInTheDocument();
  });

  test("浏览器估算只显示在最终助手，exact 接棒后移除约字", () => {
    const messages: ChatMessage[] = [
      mk("user", { id: "u-estimated-token", text: "继续" }),
      mk("tool", {
        id: "tool-estimated-token",
        toolName: "Bash",
        inputJson: { command: "pwd" },
        _completed: false,
      }),
      mk("assistant", { id: "a-estimated-token", text: "处理中" }),
    ];
    const view = render(
      <MessageList
        messages={messages}
        sending
        liveTurnUsage={{
          clientMessageId: "u-estimated-token",
          usage: { totalTokens: 128, estimated: true },
        }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("约128")).toBeInTheDocument();
    expect(screen.getAllByLabelText("本轮估算约 128 token")).toHaveLength(1);

    view.rerender(
      <MessageList
        messages={messages}
        sending
        liveTurnUsage={{
          clientMessageId: "u-estimated-token",
          usage: { totalTokens: 128 },
        }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.queryByText("约128")).not.toBeInTheDocument();
  });

  test("历史轮恢复每张卡自己的 durable 调用消耗，不复制最终助手总量", () => {
    const messages: ChatMessage[] = [
      mk("user", { id: "u-history-token", text: "运行" }),
      mk("tool", {
        id: "tool-history-token",
        toolName: "Bash",
        inputJson: { command: "pwd" },
        _completed: true,
        _callUsage: {
          callId: "a1-ccb-1",
          targetIds: ["tool-history-token"],
          usage: { totalTokens: 111 },
        },
      }),
      mk("assistant", {
        id: "a-history-token",
        text: "完成",
        usage: { totalTokens: 333 },
      }),
    ];
    render(
      <MessageList
        messages={messages}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("111")).toBeInTheDocument();
    expect(screen.getByText("333")).toBeInTheDocument();
  });

  test("旧缓存缺 targetIds/callId 的调用用量不会炸掉整条会话", () => {
    const legacy = mk("tool", {
      id: "legacy-call-usage",
      toolName: "Bash",
      inputJson: { command: "pwd" },
      _completed: true,
      _callUsage: {
        usage: { totalTokens: 42 },
      } as unknown as ChatMessage["_callUsage"],
    });
    render(
      <MessageList
        messages={[legacy, mk("assistant", { id: "legacy-call-answer", text: "正常回答" })]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("正常回答")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

describe("MessageList coalesceTeam 聚合(零回归关键路径)", () => {
  function g(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id, role: "agent-group", text, ts: 1000, _delegate: true, ...extra };
  }
  function renderList(messages: ChatMessage[]) {
    return render(
      <MessageList messages={messages} sending={false} cb={{}} onRespondPermission={() => {}} />,
    );
  }

  test("连续 ≥2 条 agent-group → 聚成团队面板", () => {
    renderList([g("g1", "任务A"), g("g2", "任务B")]);
    expect(screen.getByText("团队协作 · 2 个智能体")).toBeInTheDocument();
  });

  test("旧缓存把 usage.delegates 存成对象时跳过成本聚合而不炸整条会话", () => {
    renderList([
      mk("assistant", {
        id: "legacy-delegates",
        text: "旧缓存回答仍应显示",
        usage: { delegates: { reviewer: "3", length: 1 } } as unknown as ChatMessage["usage"],
      }),
    ]);
    expect(screen.getByText("旧缓存回答仍应显示")).toBeInTheDocument();
  });

  test("单条 agent-group → 退化回 AgentGroupCard,不出团队面板", () => {
    renderList([g("g1", "独立任务", {
      _completed: true,
      childBlocks: [{ kind: "text", text: "独立任务真实过程" }],
    })]);
    expect(screen.queryByText(/团队协作/)).not.toBeInTheDocument();
    expect(screen.getByText("独立任务")).toBeInTheDocument(); // AgentGroupCard 头部
    fireEvent.click(screen.getByText("独立任务"));
    expect(screen.getByText("独立任务真实过程")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看原始完整记录" })).not.toBeInTheDocument();
  });

  test("被其它消息夹断的 agent-group → 不聚合(各自独立卡)", () => {
    renderList([g("g1", "任务A"), mk("user", { id: "u1", text: "插话" }), g("g2", "任务B")]);
    expect(screen.queryByText(/团队协作/)).not.toBeInTheDocument();
    expect(screen.getByText("任务A")).toBeInTheDocument();
    expect(screen.getByText("任务B")).toBeInTheDocument();
  });

  test("三条连续 → 团队面板计数为 3", () => {
    renderList([g("g1", "A"), g("g2", "B"), g("g3", "C")]);
    expect(screen.getByText("团队协作 · 3 个智能体")).toBeInTheDocument();
  });

  // ── (turn 锚点, 叙事阶段) 归组:工具/thinking/骨架混排不劈裂,队长叙事文本才断组 ──
  test("同一 turn 内穿插工具行/thinking → 仍聚成一个团队面板(混排不劈裂)", () => {
    renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "任务A"),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true }),
      mk("thinking", { id: "th1", text: "思考下一步" }),
      g("g2", "任务B"),
    ]);
    expect(screen.getByText("团队协作 · 2 个智能体")).toBeInTheDocument();
  });

  test("队长叙事文本行断组:文本之后的委派另起阶段,不吸回上方面板(时序诚实)", () => {
    renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "任务A"),
      mk("assistant", { id: "a1", text: "队长阶段性整合" }),
      g("g2", "任务B"),
    ]);
    // 两个阶段各只有 1 个委派 → 都退化为单卡,不出面板;g2 按时序在文本之后。
    expect(screen.queryByText(/团队协作/)).not.toBeInTheDocument();
    expect(screen.getByText("任务A")).toBeInTheDocument();
    expect(screen.getByText("任务B")).toBeInTheDocument();
  });

  test("叙事断组后各阶段独立聚合:2 并行 + 文本 + 2 并行 → 两个面板", () => {
    renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "A1"),
      g("g2", "A2"),
      mk("assistant", { id: "a1", text: "第一批完成,继续" }),
      g("g3", "B1"),
      g("g4", "B2"),
    ]);
    expect(screen.getAllByText("团队协作 · 2 个智能体")).toHaveLength(2);
  });

  test("跨两轮的委派各自成面板(user 边界 = 独立 turn,不跨轮合并)", () => {
    renderList([
      mk("user", { id: "u1", text: "轮1" }),
      g("g1", "A1"),
      g("g2", "A2"),
      mk("user", { id: "u2", text: "轮2" }),
      g("g3", "B1"),
      g("g4", "B2"),
    ]);
    expect(screen.getAllByText("团队协作 · 2 个智能体")).toHaveLength(2);
  });

  test("server 骨架行与本地富卡混排同一 turn → 聚一个面板,超时成员单独计数", () => {
    const serverMember: ChatMessage = {
      id: "srv-g2",
      role: "agent-group",
      text: "server 队员",
      ts: 1000,
      _source: "server",
      _delegate: true,
      _delegateGoal: "server 队员",
      _completed: true,
      _delegateStatus: "timeout",
    };
    renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "本地队员", { _completed: true }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true }),
      serverMember,
    ]);
    expect(screen.getByText("团队协作 · 2 个智能体")).toBeInTheDocument();
    expect(screen.getByText(/1 完成/)).toBeInTheDocument();
    expect(screen.getByText(/1 超时/)).toBeInTheDocument();
  });

  test("旧缓存 empty incremental 自愈后：团队面板与用户问答 DOM 都在最终答复前", async () => {
    const user = mk("user", {
      id: "u-order",
      text: "一起排查",
      _orderSeq: 1,
      _source: "server",
    });
    const final = mk("assistant", {
      id: "a-order",
      text: "最终修复结论",
      _orderSeq: 2,
      _source: "server",
      _clientMessageId: user.id,
    });
    const poisoned = [
      user,
      final,
      g("g-order-1", "排查前端", { _completed: true }),
      g("g-order-2", "排查同步", { _completed: true }),
      mk("permission", {
        id: "p-order",
        toolName: "AskUserQuestion",
        requestId: "req-order",
        _resolved: true,
        _behavior: "deny",
        _settledReason: "disconnect",
        inputJson: { questions: [{ question: "是否继续？", options: [{ label: "继续" }] }] },
      }),
    ];
    const repaired = applyServerIncremental(poisoned, []);

    const { container } = renderList(repaired);
    await screen.findByText("最终修复结论");
    const team = container.querySelector('[data-testid="team-panel"]')!;
    const permission = container.querySelector('[data-testid="permission-card"]')!;
    const assistant = screen.getByText("最终修复结论").closest('[data-testid="assistant-row"]')!;
    expect(team.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(permission.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("连接断开，已自动拒绝")).toBeInTheDocument();
  });
});

describe("AgentGroupCard server-authored 骨架行渲染(债A)", () => {
  test("无 childBlocks 的 server 骨架行 → 骨架卡:目标 + 完成徽记 + 结果摘要", () => {
    renderMsg(
      mk("agent-group", {
        id: "srv-g",
        _source: "server",
        _delegate: true,
        text: "跨设备研究",
        _delegateGoal: "跨设备研究",
        _completed: true,
        _delegateStatus: "ok",
        _resultPreview: "server 端结果摘要",
      }),
    );
    expect(screen.getByText("跨设备研究")).toBeInTheDocument(); // 目标(表头)
    expect(screen.getByText("完成")).toBeInTheDocument(); // 终态徽记
    expect(screen.getByText("server 端结果摘要")).toBeInTheDocument(); // resultSummary(折叠态页脚)
  });

  test("server 骨架行 status=timeout → 超时徽记(即使 _completed 缺省)", () => {
    renderMsg(
      mk("agent-group", {
        id: "srv-t",
        _source: "server",
        _delegate: true,
        text: "超时任务",
        _delegateStatus: "timeout",
      }),
    );
    expect(screen.getByText("超时")).toBeInTheDocument();
    expect(screen.queryByText("运行中")).not.toBeInTheDocument(); // server 行永不"运行中"
  });

  test("多枚终态徽记与成本在窄屏可换行，信息仍完整", () => {
    renderMsg(
      mk("agent-group", {
        id: "srv-review",
        _source: "server",
        _delegate: true,
        _delegateAgentId: "hidden-reviewer",
        text: "质量审查",
        _completed: true,
        _reviewVerdict: "PASS",
      }),
    );
    const verdict = screen.getByText("PASS");
    expect(screen.getByText("完成")).toBeInTheDocument();
    expect(verdict.parentElement).toHaveClass("flex-wrap", "max-w-[55%]");
  });
});

describe("审查裁决徽记 + per-delegate 成本(债C/债D)", () => {
  function g(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id, role: "agent-group", text, ts: 1000, _delegate: true, ...extra };
  }
  function renderList(messages: ChatMessage[]) {
    return render(
      <MessageList messages={messages} sending={false} cb={{}} onRespondPermission={() => {}} />,
    );
  }

  test("单个审查员委派卡(退化态,经 MessageRenderer)→ 头部 PASS 徽记 + delegateCost 积分", () => {
    render(
      <MessageRenderer
        message={mk("agent-group", {
          text: "审查草稿",
          _delegate: true,
          _delegateAgentId: "hidden-reviewer",
          _completed: true,
          _delegateStatus: "ok",
          _reviewVerdict: "PASS",
        })}
        sig="agverdict"
        isLast={false}
        sending={false}
        inActiveTurn={false}
        delegateCost="7"
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("PASS")).toBeInTheDocument();
    expect(screen.getByText("7 积分")).toBeInTheDocument();
  });

  test("单个审查员卡 NEEDS_FIX → 「未通过」徽记(执行态 ok 与裁决正交)", () => {
    render(
      <MessageRenderer
        message={mk("agent-group", {
          text: "审查草稿",
          _delegate: true,
          _delegateAgentId: "hidden-reviewer",
          _completed: true,
          _delegateStatus: "ok",
          _reviewVerdict: "NEEDS_FIX",
        })}
        sig="agnf"
        isLast={false}
        sending={false}
        inActiveTurn={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("未通过")).toBeInTheDocument();
    expect(screen.getByText("完成")).toBeInTheDocument(); // 执行态徽记照常
  });

  test("coalesceTeam:审查员卡永不入面板;usage.delegates 按 agentId 落到各自单卡", () => {
    renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "审查", { _delegateAgentId: "hidden-reviewer", _completed: true, _reviewVerdict: "PASS" }),
      g("g2", "写代码", { _delegateAgentId: "coding-assistant", _completed: true }),
      mk("assistant", {
        id: "a1",
        text: "完成",
        usage: {
          delegates: [
            { agentId: "hidden-reviewer", costCredits: "3" },
            { agentId: "coding-assistant", costCredits: "5" },
          ],
        },
      }),
    ]);
    // 审查员被排除后本阶段只剩 1 个可入面板成员 → 无面板,两张单卡各带成本/裁决。
    expect(screen.queryByText(/团队协作/)).not.toBeInTheDocument();
    expect(screen.getByText("3 积分")).toBeInTheDocument();
    expect(screen.getByText("5 积分")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
  });

  test("典型团队叙事流:并行批次面板 → 队长整合文本 → 审查卡按时序独立在后(债D 成本齐全)", () => {
    const { container } = renderList([
      mk("user", { id: "u1", text: "组队" }),
      g("g1", "调研", { _delegateAgentId: "research-assistant", _completed: true }),
      g("g2", "写代码", { _delegateAgentId: "coding-assistant", _completed: true }),
      mk("assistant", {
        id: "a1",
        text: "队长整合结论",
        usage: {
          delegates: [
            { agentId: "research-assistant", costCredits: "2" },
            { agentId: "coding-assistant", costCredits: "5" },
            { agentId: "hidden-reviewer", costCredits: "3" },
          ],
        },
      }),
      g("g3", "审查草稿", { _delegateAgentId: "hidden-reviewer", _completed: true, _reviewVerdict: "PASS" }),
    ]);
    // 面板只含并行两人;审查卡独立出现,且 DOM 顺序在整合文本之后。
    expect(screen.getByText("团队协作 · 2 个智能体")).toBeInTheDocument();
    expect(screen.getByText("PASS")).toBeInTheDocument();
    const html = container.innerHTML;
    expect(html.indexOf("队长整合结论")).toBeGreaterThan(html.indexOf("团队协作"));
    expect(html.indexOf("审查草稿")).toBeGreaterThan(html.indexOf("队长整合结论"));
    // 审查卡自己的成本徽记(单卡 delegateCost 路径)。
    expect(screen.getByText("3 积分")).toBeInTheDocument();
  });
});

describe("MetaRow turn 终态门控(积分/请求ID 不得先于 turn 结束出现)", () => {
  const withUsage = (): ChatMessage[] => [
    mk("user", { id: "u1", text: "提问" }),
    mk("assistant", {
      id: "a1",
      text: "队长引擎已收笔,但审查编排还在跑",
      _completed: true,
      usage: { traceId: "trace1234abcd", costCredits: "42" },
    }),
  ];
  test("turn 进行中(sending=true)且行属活跃段 → 尾注不渲染", () => {
    render(
      <MessageList messages={withUsage()} sending={true} cb={{}} onRespondPermission={() => {}} />,
    );
    expect(screen.queryByText(/42 积分/)).not.toBeInTheDocument();
    expect(screen.queryByText(/#trace123/)).not.toBeInTheDocument();
  });
  test("turn 结束(sending=false)→ 尾注照常渲染", () => {
    render(
      <MessageList messages={withUsage()} sending={false} cb={{}} onRespondPermission={() => {}} />,
    );
    expect(screen.getByText(/42 积分/)).toBeInTheDocument();
    expect(screen.getByText(/#trace123/)).toBeInTheDocument();
  });
  test("历史段行(后有新 user)在新 turn 进行中仍显示尾注(门控只作用于活跃段)", () => {
    render(
      <MessageList
        messages={[...withUsage(), mk("user", { id: "u2", text: "下一问" })]}
        sending={true}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText(/42 积分/)).toBeInTheDocument();
  });
});

describe("MessageList 归档显式分页(§4/§5)", () => {
  const noArchive = { archivedCount: 0, archivedThroughSeq: 0, loading: false, error: false };
  function renderList(
    messages: ChatMessage[],
    archive?: Partial<typeof noArchive> & { onLoadOlder?: () => void | Promise<void> },
  ) {
    const onLoadOlder = archive?.onLoadOlder ?? (() => {});
    return render(
      <MessageList
        messages={messages}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
        archive={archive ? { ...noArchive, ...archive, onLoadOlder } : undefined}
      />,
    );
  }
  // 轻量 user 行(无 _seq → archivedLoaded=0),批量造尾巴。
  function users(n: number): ChatMessage[] {
    return Array.from({ length: n }, (_, i) => mk("user", { id: `u${i}`, text: `m${i}` }));
  }

  test("已加载的 130 条热尾全部属于数据模型，DOM 有界由生产虚拟列表负责", () => {
    renderList(users(130), { archivedCount: 500, archivedThroughSeq: 5 });
    expect(screen.getByText("m0")).toBeInTheDocument();
    expect(screen.getByText("m129")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看更早历史记录（还有 500 条）/ })).toBeInTheDocument();
  });

  test("无归档时不造客户端 100 条总量上限", () => {
    const { container } = renderList(users(130));
    expect(screen.getByText("m0")).toBeInTheDocument();
    expect(screen.getByText("m129")).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
  });

  test("统一时间线保留最新思考、工具和回答，完成态思考默认折叠且可完整展开", () => {
    const rows = [
      mk("user", { id: "u-latest", text: "最新问题", ts: 1, _timelineRecord: true }),
      mk("thinking", {
        id: "thinking-latest",
        text: "最新真实思考",
        ts: 2,
        _timelineRecord: true,
        _timelineUnitKey: "tape:t:0:0:thinking-latest",
      }),
      mk("tool", {
        id: "tool-latest",
        text: "最新真实工具输出",
        output: "最新真实工具输出",
        toolName: "Bash",
        _completed: true,
        ts: 3,
        _timelineRecord: true,
        _timelineUnitKey: "tape:t:1:0:tool-latest",
      }),
      mk("assistant", {
        id: "answer-latest",
        text: "最新真实回答",
        ts: 4,
        _timelineRecord: true,
        _timelineUnitKey: "tape:t:2:0:answer-latest",
      }),
      mk("runtime-event", {
        id: "turn-process:stale",
        _turnTapeProcess: true,
        text: "绝不能展示",
      }),
    ];
    render(
      <MessageList messages={rows} sending={false} cb={{}} onRespondPermission={() => {}} />,
    );
    expect(screen.queryByText("最新真实思考")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("最新真实思考")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /终端/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /终端/ }));
    expect(screen.getByText("最新真实工具输出")).toBeInTheDocument();
    expect(screen.getByText("最新真实回答")).toBeInTheDocument();
    expect(screen.queryByText(/Agent 调用过程|查看原始思考记录|绝不能展示/)).toBeNull();
  });

  test("统一时间线思考从实时态结束后自动折叠，点击仍恢复完整正文", () => {
    const thinking = mk("thinking", {
      id: "thinking-live-to-complete",
      text: "EXACT_LIVE_TO_COMPLETE_THINKING",
      ts: 2,
      _timelineRecord: true,
      _timelineUnitKey: "tape:t:0:0:thinking-live-to-complete",
    });
    const renderState = (sending: boolean) => (
      <MessageList
        messages={[thinking]}
        sending={sending}
        cb={{}}
        onRespondPermission={() => {}}
      />
    );
    const view = render(renderState(true));

    expect(screen.getByRole("button", { name: "思考过程" })).toBeInTheDocument();
    expect(screen.getByText("EXACT_LIVE_TO_COMPLETE_THINKING")).toBeInTheDocument();

    view.rerender(renderState(false));

    expect(screen.queryByText("EXACT_LIVE_TO_COMPLETE_THINKING")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("EXACT_LIVE_TO_COMPLETE_THINKING")).toBeInTheDocument();
  });

  test("自动恢复只保留原问题、真实过程和最终结果，不展示控制 user 行或中间错误卡", () => {
    const rows: ChatMessage[] = [
      mk("user", { id: "retry-root", text: "原始用户问题", status: "error", ts: 1 }),
      mk("assistant", {
        id: "retry-intermediate-error",
        text: "INTERMEDIATE_ERROR_SHOULD_HIDE",
        ts: 2,
        _source: "server",
        _clientMessageId: "retry-root",
        _errorCode: "model_capacity",
      }),
      mk("user", {
        id: "retry-child",
        text: "AUTO_RETRY_CONTROL_ROW_SHOULD_HIDE",
        ts: 3,
        _source: "server",
        _isAutoRetry: true,
        _automaticRecovery: true,
        _recoveryOfClientMessageId: "retry-root",
      }),
      mk("thinking", {
        id: "retry-thinking",
        text: "恢复后的真实过程",
        ts: 4,
        _source: "server",
        _clientMessageId: "retry-child",
      }),
      mk("assistant", {
        id: "retry-final",
        text: "最终恢复结果",
        ts: 5,
        _source: "server",
        _clientMessageId: "retry-child",
      }),
    ];
    render(<MessageList messages={rows} sending={false} cb={{}} onRespondPermission={() => {}} />);
    expect(screen.getByText("原始用户问题")).toBeInTheDocument();
    expect(screen.getByText("最终恢复结果")).toBeInTheDocument();
    expect(screen.queryByText("INTERMEDIATE_ERROR_SHOULD_HIDE")).toBeNull();
    expect(screen.queryByText("AUTO_RETRY_CONTROL_ROW_SHOULD_HIDE")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    expect(screen.getByText("恢复后的真实过程")).toBeInTheDocument();
  });

  test("缺 id 的坏消息只变成占位，前后正常消息仍渲染", () => {
    render(
      <MessageList
        messages={[
          mk("user", { id: "u-ok", text: "正常用户问题" }),
          { role: "assistant", text: "缺 id 的坏行", ts: 2 } as unknown as ChatMessage,
          mk("assistant", { id: "a-ok", text: "正常助手回复" }),
        ]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("正常用户问题")).toBeInTheDocument();
    expect(screen.getByText("正常助手回复")).toBeInTheDocument();
    expect(screen.getByText("此条消息缺少 id，已跳过渲染")).toBeInTheDocument();
  });

  test("生产滚动容器尚未绑定时不先挂载整个超长会话", () => {
    render(
      <MessageList
        messages={users(10_000)}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={null}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在准备会话");
    expect(screen.queryByText("m0")).toBeNull();
    expect(screen.queryByText("m9999")).toBeNull();
  });

  test("滚动到任意位置都不会触发历史请求", async () => {
    const onLoadOlder = vi.fn();
    const scroller = document.createElement("div");
    scroller.className = "chat-scroll-area";
    document.body.appendChild(scroller);
    render(
      <MessageList
        messages={[
          ...users(300).map((message, index) => ({
            ...message,
            id: `tail-${index}`,
            text: `很长的最终尾部 ${index}`,
            ts: index + 2,
          })),
        ]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration="far-control"
        archive={{ ...noArchive, archivedCount: 100, archivedThroughSeq: 5, onLoadOlder }}
      />,
    );
    fireEvent.wheel(scroller, { deltaY: -600 });
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await act(async () => {});
    expect(onLoadOlder).not.toHaveBeenCalled();
    scroller.remove();
  });

  test("任何 runtime 传输审计记录都不进入会话卡片，真实 Agent 记录完整保留", () => {
    const onRegenerate = vi.fn();
    const visible: ChatMessage[] = [
      mk("user", { id: "u-visible", text: "可见提问", status: "sent", ts: 1 }),
      mk("runtime-event", {
        id: "turn-process:tape-visible",
        text: "",
        ts: 1,
        _turnTapeProcess: true,
        _turnTapeProcessExpanded: true,
        _turnTapeProcessCursor: null,
        _turnTapeId: "tape-visible",
      }),
      mk("thinking", { id: "th-visible", text: "**可见思考**", ts: 2 }),
      mk("tool", {
        id: "tool-visible",
        text: "",
        toolName: "exec_command",
        inputJson: { cmd: "printf ok" },
        output: "ok",
        _completed: true,
        ts: 3,
      }),
      mk("runtime-event", {
        id: "runtime-progress-visible",
        text: "",
        ts: 3.5,
        _runtimeSource: "gateway",
        _runtimeEvent: { type: "progress", subtype: "tool_delta", exact: "非重复运行事件" },
      }),
      mk("assistant", { id: "a-visible", text: "可见最终答复", ts: 4 }),
    ];
    const runtime = Array.from({ length: 193 }, (_, i) => ({
      id: `runtime-${i}`,
      role: "runtime-event",
      text: "",
      ts: 5 + i,
      _runtimeSource: "ccb",
      _runtimeEvent: { type: "stream_event", event: { index: i } },
    })) as unknown as ChatMessage[];
    const bashTails = Array.from({ length: 80 }, (_, i) => ({
      id: `bash-tail-${i}`,
      role: "runtime-event",
      text: "",
      ts: 210 + i,
      _runtimeSource: "ccb",
      _runtimeEvent: {
        type: "system",
        subtype: "bash_output_tail",
        tool_use_id: "tool-visible",
        tail: `真实后台输出 ${i}`,
        total_bytes: i + 1,
      },
    })) as unknown as ChatMessage[];
    const batchLocator = mk("runtime-event", {
      id: "srv-turn-runtime-batch-0-127-aabbccddeeff",
      text: "",
      ts: 300,
      _payloadDeferred: true,
      _turnTapeId: "tape-visible",
      _recordOrdinal: 99,
    });
    const onFetchTapeRecordPayload = vi.fn().mockResolvedValue([
      mk("runtime-event", {
        id: "batch-duplicate",
        _runtimeSource: "ccb",
        _runtimeEvent: { type: "stream_event", event: { type: "message_delta" } },
      }),
      mk("runtime-event", {
        id: "batch-progress",
        _runtimeSource: "ccb",
        _runtimeEvent: { type: "tool_progress", tool_use_id: "tool-visible", elapsed_time_seconds: 1 },
      }),
    ]);

    render(
      <MessageList
        messages={[...visible, ...runtime, ...bashTails, batchLocator]}
        sending={false}
        cb={{ onRegenerate, onFetchTapeRecordPayload }}
        onRespondPermission={() => {}}
      />,
    );

    expect(screen.getByText("可见提问")).toBeInTheDocument();
    expect(screen.getByText("可见最终答复")).toBeInTheDocument();
    expect(screen.getByText(/已思考/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /progress · tool_delta/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /bash_output_tail/ })).toBeNull();
    expect(onFetchTapeRecordPayload).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /tool_progress/ })).toBeNull();
    expect(screen.queryAllByText("查看原始记录")).toHaveLength(0);
  });

  test("未识别的 immutable tape 角色不会被静默丢弃", () => {
    const marker = "EXACT_FUTURE_ROLE_PAYLOAD";
    renderMsg({
      id: "future-role-1",
      role: "future-engine-event" as ChatMessage["role"],
      text: marker,
      ts: 1,
      _turnTapeId: "tape-future-role",
      _turnTapeComplete: true,
    });

    expect(screen.getByText("原始 Agent 记录 · future-engine-event")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /原始 Agent 记录/ }));
    expect(document.body.textContent).toContain(marker);
  });

  test("统一时间线中的未来角色即使没有 tape id 也不会被静默丢弃", () => {
    const marker = "EXACT_FUTURE_TIMELINE_PAYLOAD";
    renderMsg({
      id: "future-timeline-role-1",
      role: "future-timeline-event" as ChatMessage["role"],
      text: marker,
      ts: 2,
      _timelineRecord: true,
      _timelineUnitKey: "outer:88:future-timeline-role-1",
    });

    expect(screen.getByText("原始 Agent 记录 · future-timeline-event")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /原始 Agent 记录/ }));
    expect(document.body.textContent).toContain(marker);
  });

  test("计划卡保留易读体验，同时可查看 immutable tape 的完整事件序列", () => {
    const marker = "EXACT_PLAN_EVENT_HISTORY_MARKER";
    renderMsg({
      id: "plan-tape-1",
      role: "plan",
      text: "执行计划",
      ts: 1,
      steps: [{ step: "完成修复", status: "completed" }],
      _turnTapeId: "tape-plan",
      _turnTapeComplete: true,
      _eventHistory: [
        { kind: "plan", partial: true, future_field: marker },
        { kind: "plan", partial: false, steps: [{ step: "完成修复", status: "completed" }] },
      ],
    });

    expect(screen.getByText("完成修复")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(screen.getByRole("button", { name: "查看原始计划记录" }));
    expect(document.body.textContent).toContain(marker);
  });

  test("rolling old cache里的 substitution 行会被丢弃，不能覆盖真实答复", () => {
    const projection = mk("system", {
      id: "projection-checkpoint:tape-1",
      text: "绝不能展示的 checkpoint",
      _historyProjection: { kind: "legacy-checkpoint" },
    } as unknown as Partial<ChatMessage>);
    renderList([mk("assistant", { id: "answer", text: "正常答复" }), projection]);
    expect(screen.getByText("正常答复")).toBeInTheDocument();
    expect(screen.queryByText("绝不能展示的 checkpoint")).toBeNull();
  });

  test("本地翻尽 + 有归档未拉 → 只显示显式按钮，点击才加载一页", async () => {
    const onLoadOlder = vi.fn();
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, onLoadOlder });
    expect(onLoadOlder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查看更早历史记录（还有 500 条）/ }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
  });

  test("生产虚拟滚动到顶部也不请求归档，只有点击按钮才请求", async () => {
    const onLoadOlder = vi.fn();
    const scroller = document.createElement("div");
    scroller.className = "chat-scroll-area";
    document.body.appendChild(scroller);
    render(
      <MessageList
        messages={users(30)}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
        archive={{ ...noArchive, archivedCount: 500, archivedThroughSeq: 5, onLoadOlder }}
        scrollParent={scroller}
      />,
    );

    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await act(async () => {});
    expect(onLoadOlder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查看更早历史记录/ }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    scroller.remove();
  });

  test("统一历史请求在途时按钮原位禁用，不会发起第二条分页请求", async () => {
    let finishArchive!: () => void;
    const archivePage = new Promise<void>((resolve) => { finishArchive = resolve; });
    const onLoadOlder = vi.fn(() => archivePage);

    render(
      <MessageList
        messages={[mk("assistant", { id: "answer", text: "最新回答" })]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
        archive={{ ...noArchive, archivedCount: 20, archivedThroughSeq: 5, onLoadOlder }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /查看更早历史记录（还有 20 条）/ }));
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "加载中…" })).toBeDisabled();

    await act(async () => finishArchive());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  test("本地翻尽 + 无归档 → 无按钮", () => {
    const { container } = renderList(users(3), { archivedCount: 0 });
    expect(container.querySelector("button")).toBeNull();
  });

  test("云端加载中 → 原位禁用按钮并给出明确反馈", () => {
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, loading: true });
    const button = screen.getByRole("button", { name: "加载中…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  test("云端加载失败 → 按钮显示「加载失败，点击重试」且可点(重试)", async () => {
    const onLoadOlder = vi.fn();
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, error: true, onLoadOlder });
    const btn = screen.getByRole("button", { name: /加载失败，点击重试/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
  });

  test("拉回一页归档后不回退本地翻页:带 _seq≤水位 的前插行可见,仍是云端态", () => {
    // 3 尾巴 + 100 已拉归档行(_seq 1..100 ≤ 水位 100);archivedCount 500。
    const archived: ChatMessage[] = Array.from({ length: 100 }, (_, i) =>
      mk("user", { id: `a${i}`, text: `arch${i}`, _seq: i + 1 }),
    );
    const tail: ChatMessage[] = Array.from({ length: 3 }, (_, i) =>
      mk("user", { id: `t${i}`, text: `tail${i}`, _seq: 200 + i }),
    );
    renderList([...archived, ...tail], { archivedCount: 500, archivedThroughSeq: 100 });
    // 刚拉回的归档行未被再次藏起 → arch0 / arch99 都在 DOM。
    expect(screen.getByText("arch0")).toBeInTheDocument();
    expect(screen.getByText("arch99")).toBeInTheDocument();
    // 仍是云端态,剩余 = 500-100 = 400；已加载行常驻，继续点击才取下一页。
    expect(screen.getByRole("button", { name: /查看更早历史记录（还有 400 条）/ })).toBeInTheDocument();
    expect(screen.queryByText(/加载更多历史/)).toBeNull();
  });
});

describe("连续 thinking 行渲染层合并(codex 空正文标题卡)", () => {
  function renderList(messages: ChatMessage[], sending = false) {
    return render(
      <MessageList messages={messages} sending={sending} cb={{}} onRespondPermission={() => {}} />,
    );
  }
  const think = (id: string, text: string): ChatMessage => mk("thinking", { id, text });

  test("连续多条 thinking(真实 codex 摘要)→ 合并成单张卡(分组数量=1)", () => {
    renderList([
      mk("user", { id: "u1", text: "演示工具卡", status: "sent" }),
      think("th1", THINKING_HEADLINES_ONLY),
      think("th2", THINKING_MULTI_SEGMENT),
    ]);
    // 完成态折叠,单一"已思考 · 摘要"表头 → 恰好 1 张思考卡(合并生效,非两排空卡)。
    expect(screen.getAllByText(/已思考/)).toHaveLength(1);
    // 折叠态摘要取最新段(th2)首个粗体标题。
    expect(screen.getByText(/已思考 · Creating generated tool-card-demo\.txt file/)).toBeInTheDocument();
  });

  test("组内末条流式(sending)→ 整卡稳定显示「思考过程」,不显示「已思考」", () => {
    renderList(
      [
        mk("user", { id: "u1", text: "q", status: "sent" }),
        think("th1", "**Step one**"),
        think("th2", "**Step two**"),
      ],
      true,
    );
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.queryByText(/已思考/)).toBeNull();
  });

  test("中间夹可见 goal 行 → 打断 thinking 连续性并渲染目标卡", () => {
    renderList([
      mk("user", { id: "u1", text: "q", status: "sent" }),
      think("th1", "**Alpha**"),
      mk("goal", { id: "g1", text: "目标", goalStatus: "active" }),
      think("th2", "**Beta**"),
    ]);
    expect(screen.getAllByText(/已思考/)).toHaveLength(2);
    expect(screen.getByText("目标")).toBeInTheDocument();
  });

  test("被会渲染的 assistant 叙事行打断 → 分成两张思考卡", () => {
    renderList([
      mk("user", { id: "u1", text: "q", status: "sent" }),
      think("th1", "**Alpha**"),
      mk("assistant", { id: "a1", text: "中间答复" }),
      think("th2", "**Beta**"),
    ]);
    expect(screen.getAllByText(/已思考/)).toHaveLength(2);
  });

  test("富化正文:`**标题**` 渲染为粗体,展开后 DOM 无裸星号", async () => {
    const { container } = renderList([
      mk("user", { id: "u1", text: "q", status: "sent" }),
      think("th1", THINKING_HEADLINES_ONLY),
    ]);
    // 完成态默认折叠 → 点开表头展开正文。
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    // Markdown 经 React.lazy 异步加载:占位期是含 `**` 的纯文本,富文本解析完成后 `**标题**`→<strong>。
    const strong = await screen.findByText("Planning tool usage strategy");
    expect(strong.tagName).toBe("STRONG");
    // 富化后整卡 DOM 不得残留裸 `**`(现网星号裸露 bug 的回归钉)。
    expect(container.textContent).not.toContain("**");
  });

  test("展开合并卡 → 两条 thinking 消息的段都在(多段渲染)", async () => {
    renderList([
      mk("user", { id: "u1", text: "q", status: "sent" }),
      think("th1", THINKING_HEADLINES_ONLY),
      think("th2", THINKING_MULTI_SEGMENT),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /已思考/ }));
    // 首条消息(th1)末标题 + 末条消息(th2)末标题都被富化为粗体 → 证明两段都进了同一张卡。
    const s1 = await screen.findByText("Planning explicit collaboration spawn");
    expect(s1.tagName).toBe("STRONG");
    const s2 = await screen.findByText("Debugging template literal parsing");
    expect(s2.tagName).toBe("STRONG");
  });

  test("MessageRenderer 单条兜底路径:仍渲染单段思考卡(流式态)", () => {
    render(
      <MessageRenderer
        message={mk("thinking", { id: "solo", text: "推理中..." })}
        sig={messageSignature(mk("thinking", { id: "solo", text: "推理中..." }), { isLast: true, sending: true })}
        isLast={true}
        sending={true}
        inActiveTurn={true}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.getByText("推理中...")).toBeInTheDocument();
  });
});

describe("长时间线虚拟分页与活跃状态稳定性", () => {
  const processRow = (
    id: string,
    pageKey: string,
    ordinal: number,
  ): ChatMessage => ({
    id,
    role: "system",
    text: `真实过程 ${id}`,
    ts: ordinal,
    _source: "server",
    _turnTapeId: "tape-chunks",
    _turnTapeOrdinal: ordinal,
    _turnTapeProcessLoadedFrom: "tape-chunks::sha::turn-process:tape-chunks",
    _turnTapeProcessPageKey: pageKey,
  } as ChatMessage);

  test("每条真实记录各占一个虚拟项，不按物理页合并成巨型滚动项", () => {
    const pageA = Array.from({ length: 70 }, (_, index) => processRow(`a-${index}`, "page-a", index));
    const pageB = Array.from({ length: 35 }, (_, index) => processRow(`b-${index}`, "page-b", 100 + index));
    const { container } = render(
      <MessageList
        messages={[...pageA, ...pageB]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );

    expect(container.querySelector("[data-tape-page-chunk]")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-chat-virtual-key]")).toHaveLength(105);
    expect(screen.getByText("真实过程 a-0")).toBeInTheDocument();
    expect(screen.getByText("真实过程 b-34")).toBeInTheDocument();
  });

  test("sending 期间只有一份同 DOM 活动状态，tool/thinking/assistant 切换不再闪烁", () => {
    const user = mk("user", { id: "stable-user", text: "问题", status: "sent" });
    const tool = mk("tool", {
      id: "stable-tool",
      toolName: "Bash",
      inputJson: { command: "sleep 1" },
      _completed: false,
    });
    const view = render(
      <MessageList
        messages={[user, tool]}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    const status = screen.getByLabelText("生成中");
    expect(screen.getAllByLabelText("生成中")).toHaveLength(1);

    const thinking = mk("thinking", { id: "stable-thinking", text: "真实思考过程" });
    view.rerender(
      <MessageList
        messages={[user, tool, thinking]}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getAllByLabelText("生成中")).toHaveLength(1);
    expect(screen.getByLabelText("生成中")).toBe(status);
    expect(screen.getByText("思考过程")).toBeInTheDocument();

    const assistant = mk("assistant", { id: "stable-answer", text: "正在生成正文" });
    view.rerender(
      <MessageList
        messages={[user, tool, thinking, assistant]}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getAllByLabelText("生成中")).toHaveLength(1);
    expect(screen.getByLabelText("生成中")).toBe(status);
  });

  test("移动端冷会话首条记录未到时仍显示加载/活动状态，不留整屏空白", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    render(
      <MessageList
        messages={[]}
        sending
        historyLoading
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
      />,
      { container: scroller },
    );
    expect(screen.getByLabelText("生成中")).toBeInTheDocument();
    expect(screen.getByLabelText("正在加载会话内容")).toBeInTheDocument();
  });

  test("生产 Virtuoso Footer 组件身份稳定，stream delta 不重挂活动 DOM", async () => {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const user = mk("user", { id: "virtual-user", text: "问题", status: "sent" });
    const tool = mk("tool", {
      id: "virtual-tool",
      toolName: "Bash",
      inputJson: { command: "sleep 1" },
      _completed: false,
    });
    const view = render(
      <MessageList
        messages={[user, tool]}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
      />,
      { container: scroller },
    );
    const status = await screen.findByLabelText("生成中");

    view.rerender(
      <MessageList
        messages={[user, tool, mk("thinking", { id: "virtual-thinking", text: "真实思考" })]}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
      />,
    );
    expect(await screen.findByLabelText("生成中")).toBe(status);
  });

  test("timeline generation 变化会重建 Virtuoso，避免 live→tape 复用旧测量图", async () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    const user = mk("user", { id: "generation-user", text: "问题", status: "sent" });
    const activeRows = [
      user,
      ...Array.from({ length: 220 }, (_, index) =>
        mk("thinking", { id: "live-row-" + index, text: "实时记录 " + index }),
      ),
    ];
    const view = render(
      <MessageList
        messages={activeRows}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration="generation-4"
      />,
      { container: scroller },
    );
    const before = await screen.findByLabelText("生成中");

    view.rerender(
      <MessageList
        messages={activeRows}
        sending
        turnActivity={{ startedAt: Date.now(), agentName: "助手" }}
        cb={{}}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration="generation-5"
      />,
    );

    expect(await screen.findByLabelText("生成中")).not.toBe(before);
    scroller.remove();
  });
});

describe("context_rebuilt system 提示行(§3.3/§5,复用 SystemCard 灰字样式)", () => {
  test("role:'system' 上下文重建行 → 居中灰字提示渲染(不新造样式)", () => {
    const text = "已重新加载会话上下文（最近 40 条对话摘要）。更早的细节助手可能记不全，如需引用旧内容可直接粘贴。";
    render(
      <MessageList
        messages={[
          mk("user", { id: "u1", text: "继续" }),
          mk("system", { id: "sys-ctx", text }),
        ]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe("MessageList 活跃段归属(turnSegment 收口)", () => {
  const todoTool = (id: string): ChatMessage =>
    mk("tool", {
      id,
      toolName: "TodoWrite",
      inputJson: { todos: [{ content: "旧任务", status: "in_progress" }] },
      _completed: true,
    });
  function renderList(messages: ChatMessage[], sending: boolean) {
    return render(
      <MessageList messages={messages} sending={sending} cb={{}} onRespondPermission={() => {}} />,
    );
  }

  test("当前 turn 的 TodoWrite 在发送中被抑制(HUD 接管)", () => {
    renderList([mk("user", { id: "u1", text: "做任务" }), todoTool("t1")], true);
    expect(screen.queryByText("任务列表")).toBeNull();
  });

  test("上一轮的 TodoWrite 在新 turn 中按历史段渲染只读卡(不再被抑制)", () => {
    renderList(
      [
        mk("user", { id: "u1", text: "做任务" }),
        todoTool("t1"),
        mk("user", { id: "u2", text: "换个话题" }),
      ],
      true,
    );
    expect(screen.getByText("任务列表")).toBeInTheDocument();
  });
});

// ═══════════════ 生成占位卡（需求 C）触发面 ═══════════════
describe("生成占位卡渲染", () => {
  const JOB = "a".repeat(32);

  test("本地占位行（imageEdit 提交）→ MessageList 拦截渲染占位卡", () => {
    render(
      <MessageList
        messages={[
          mk("user", { id: "u1", text: "把杯子改成玻璃杯" }),
          mk("system", {
            id: "ph1",
            _genPlaceholder: { jobId: JOB, aspect: "9:16", status: "running", startedAt: Date.now() },
          }),
        ]}
        sending={true}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByTestId("generating-placeholder")).toBeInTheDocument();
    expect(screen.getByText("正在生成 · 约几十秒")).toBeInTheDocument();
  });

  test("本地占位行 failed → 渲染失败态", () => {
    render(
      <MessageList
        messages={[
          mk("system", {
            id: "ph1",
            _genPlaceholder: {
              jobId: JOB,
              aspect: 1,
              status: "failed",
              startedAt: Date.now(),
              reason: "模型服务暂时不可用",
            },
          }),
        ]}
        sending={false}
        cb={{}}
        onRespondPermission={() => {}}
      />,
    );
    expect(screen.getByText("图片生成失败")).toBeInTheDocument();
    expect(screen.getByText("模型服务暂时不可用")).toBeInTheDocument();
  });

  test("模型原生 imagegen（codex:imageGeneration）running → 占位卡", () => {
    renderMsg(mk("tool", { toolName: "codex:imageGeneration", inputJson: { prompt: "a cat" } }));
    expect(screen.getByTestId("generating-placeholder")).toBeInTheDocument();
  });

  test("模型原生 imagegen 完成 → 回落 ToolCardSlot（不再出占位卡）", () => {
    renderMsg(
      mk("tool", {
        toolName: "codex:imageGeneration",
        _completed: true,
        inputJson: { prompt: "a cat", status: "completed", savedPath: "/gen/cat.png" },
      }),
    );
    expect(screen.queryByTestId("generating-placeholder")).toBeNull();
  });

  test("模型原生 imagegen 失败态（input.status=failed）→ 不出占位卡，回落工具卡", () => {
    renderMsg(
      mk("tool", { toolName: "codex:imageGeneration", inputJson: { prompt: "x", status: "failed" } }),
    );
    expect(screen.queryByTestId("generating-placeholder")).toBeNull();
  });
});

// ═══════════════ 评价反馈行只挂每轮末条 assistant 正文（boss 07-11） ═══════════════
describe("ResponseRating 只挂轮末条 assistant 正文(中间回复不出)", () => {
  const RATING_PROMPT = "这条回复怎么样?";
  // 经 ResponseRatingProvider(非 null value)才会真正挂 ResponseRatingCard;App 侧同款包裹。
  function renderRatable(messages: ChatMessage[], sending = false) {
    return render(
      <ResponseRatingProvider value={{ ratings: new Map(), submit: () => {} }}>
        <MessageList messages={messages} sending={sending} cb={{}} onRespondPermission={() => {}} />
      </ResponseRatingProvider>,
    );
  }

  test("一轮含 文本A→工具卡→文本B(终态):A 底部无评价行、B 有", () => {
    const { container } = renderRatable([
      mk("user", { id: "u1", text: "提问" }),
      mk("assistant", { id: "aA", text: "第一段回复内容" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true, output: "ok" }),
      mk("assistant", { id: "aB", text: "第二段回复内容", _completed: true }),
    ]);
    // 全轮只出 1 行评价(轮末条 B),中间段 A 不出。
    expect(screen.getAllByText(RATING_PROMPT)).toHaveLength(1);
    // 且这唯一的评价行位于末条 B 之后(DOM 顺序诚实:非误挂在中间段 A 上)。
    const html = container.innerHTML;
    expect(html.indexOf(RATING_PROMPT)).toBeGreaterThan(html.indexOf("第二段回复内容"));
  });

  test("两个历史轮 → 各自末条都有评价(不是仅全会话末条)", () => {
    renderRatable([
      mk("user", { id: "u1", text: "轮1" }),
      mk("assistant", { id: "a1m", text: "轮1中间段" }),
      mk("tool", { id: "t1", toolName: "Bash", _completed: true }),
      mk("assistant", { id: "a1e", text: "轮1末尾段" }),
      mk("user", { id: "u2", text: "轮2" }),
      mk("assistant", { id: "a2e", text: "轮2末尾段" }),
    ]);
    // 轮1末尾 + 轮2末尾 各一行 = 2;轮1中间段不出。
    expect(screen.getAllByText(RATING_PROMPT)).toHaveLength(2);
  });

  test("流式中(sending)末条不出评价行(终态门控保留)", () => {
    // 末条即流式 assistant → isLive 抑制。
    renderRatable(
      [mk("user", { id: "u1", text: "问" }), mk("assistant", { id: "a1", text: "流式回复中" })],
      true,
    );
    expect(screen.queryByText(RATING_PROMPT)).toBeNull();
  });

  test("流式中:已完成的轮末条 assistant 亦不出(活跃段 sending 门控优先于 flag)", () => {
    // A 已完成(非 live)且是本轮末条正文,但本轮仍在流(后面挂着运行中的工具)→ 活跃段门控抑制。
    renderRatable(
      [
        mk("user", { id: "u1", text: "问" }),
        mk("assistant", { id: "aA", text: "已完成的一段", _completed: true }),
        mk("tool", { id: "t1", toolName: "Bash", _completed: false }),
      ],
      true,
    );
    expect(screen.queryByText(RATING_PROMPT)).toBeNull();
  });
});
