import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { messageSignature } from "../lib/chat/render";
import { MessageList, MessageRenderer } from "./MessageRenderer";
import type { CardCallbacks } from "./chat/cards";
import type { PermissionRespond } from "./chat/PermissionCard";

afterEach(cleanup);

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role, text: "", ts: 1000, ...extra };
}

function renderMsg(
  message: ChatMessage,
  opts: {
    isLast?: boolean;
    sending?: boolean;
    cb?: CardCallbacks;
    onRespond?: PermissionRespond;
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
      cb={opts.cb ?? {}}
      onRespondPermission={opts.onRespond ?? (() => {})}
    />,
  );
}

describe("MessageRenderer 角色分派 + 非工具卡", () => {
  test("assistant：渲染 markdown 正文（懒加载 chunk 解析后富文本生效）", async () => {
    renderMsg(mk("assistant", { text: "你好**世界**" }));
    // Markdown 经 React.lazy 异步加载：占位期渲染纯文本整段「你好**世界**」。
    // 用精确匹配「世界」跳过占位（占位无独立「世界」节点），等到真正的富文本解析完成，
    // 届时 **世界** 被渲染为 <strong>世界</strong> —— 既验证内容到位，又验证懒加载边界确实落地。
    // 懒加载 chunk 在全量套件并发下解析可能 >1s，给足超时余量(隔离稳过,仅满负载偶发)。
    const strong = await screen.findByText("世界", {}, { timeout: 5000 });
    expect(strong.tagName).toBe("STRONG");
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

  test("user：气泡 + 状态角标", () => {
    renderMsg(mk("user", { text: "提问", status: "sent" }));
    expect(screen.getByText("提问")).toBeInTheDocument();
    expect(screen.getByText("已送达")).toBeInTheDocument();
  });

  test("thinking：流式态显示「思考中…」并展开", () => {
    renderMsg(mk("thinking", { text: "推理中..." }), { isLast: true, sending: true });
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(screen.getByText("推理中...")).toBeInTheDocument();
  });

  test("plan：渲染步骤", () => {
    renderMsg(
      mk("plan", {
        text: "计划",
        steps: [
          { step: "第一步", status: "completed" },
          { step: "第二步", status: "inProgress" },
        ],
      }),
    );
    expect(screen.getByText("第一步")).toBeInTheDocument();
    expect(screen.getByText("第二步")).toBeInTheDocument();
  });

  test("system：居中提示", () => {
    renderMsg(mk("system", { text: "会话已恢复" }));
    expect(screen.getByText("会话已恢复")).toBeInTheDocument();
  });

  test("goal（v5 不实现）→ 不渲染任何内容", () => {
    const { container } = renderMsg(mk("goal", { text: "目标" }));
    expect(container.textContent).toBe("");
  });
});

describe("tool / agent-group 集成", () => {
  test("tool role → 委托 ToolCard 渲染（完成态）", () => {
    renderMsg(mk("tool", { toolName: "Bash", inputJson: { command: "ls" }, _completed: true, output: "x" }));
    expect(screen.getByText("完成")).toBeInTheDocument();
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
});

describe("permission 审批", () => {
  test("已允许（普通工具）→ 状态展示", () => {
    renderMsg(mk("permission", { toolName: "Bash", requestId: "r1", _resolved: true, _behavior: "allow" }));
    expect(screen.getByText("已允许")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  test("待审批普通工具 → 自动弹审批框，允许经 onRespondPermission 回送", () => {
    const onRespond = vi.fn();
    renderMsg(mk("permission", { toolName: "Bash", requestId: "r1", _resolved: false, inputPreview: "ls -la" }), {
      onRespond,
    });
    // 自动弹出的 modal（Radix portal）含「允许」。
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(onRespond).toHaveBeenCalledWith({ requestId: "r1", behavior: "allow" });
  });

  test("AskUserQuestion → 答题框，选项提交回送 updatedInput.answers", () => {
    const onRespond = vi.fn();
    renderMsg(
      mk("permission", {
        toolName: "AskUserQuestion",
        requestId: "r2",
        _resolved: false,
        inputJson: {
          questions: [{ question: "选择颜色？", options: [{ label: "红" }, { label: "蓝" }] }],
        },
      }),
      { onRespond },
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

  test("单条 agent-group → 退化回 AgentGroupCard,不出团队面板", () => {
    renderList([g("g1", "独立任务")]);
    expect(screen.queryByText(/团队协作/)).not.toBeInTheDocument();
    expect(screen.getByText("独立任务")).toBeInTheDocument(); // AgentGroupCard 头部
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
});
