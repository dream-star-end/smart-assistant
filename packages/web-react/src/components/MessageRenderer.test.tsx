import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/chat/model";
import { messageSignature } from "../lib/chat/render";
import { MessageList, MessageRenderer } from "./MessageRenderer";
import type { CardCallbacks } from "./chat/cards";
import type { PermissionRespond } from "./chat/PermissionCard";
import { ResponseRatingProvider } from "./chat/ResponseRating";
import {
  THINKING_HEADLINES_ONLY,
  THINKING_MULTI_SEGMENT,
} from "./tool/__fixtures__/sessionToolTexts";

afterEach(cleanup);

function mk(role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role, text: "", ts: 1000, ...extra };
}

function renderMsg(
  message: ChatMessage,
  opts: {
    isLast?: boolean;
    sending?: boolean;
    inActiveTurn?: boolean;
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
      inActiveTurn={opts.inActiveTurn ?? true}
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
    expect(screen.getByText("legacy output")).toBeInTheDocument();
    expect(screen.getByText("终端")).toBeInTheDocument();
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

describe("MessageList 归档分页按钮三态(§4/§5)", () => {
  const noArchive = { archivedCount: 0, archivedThroughSeq: 0, loading: false, error: false };
  function renderList(messages: ChatMessage[], archive?: Partial<typeof noArchive> & { onLoadOlder?: () => void }) {
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

  test("本地未翻尽(>100 条)→ 本地翻页按钮;count 含归档未拉数(§4)", () => {
    // 130 条尾巴,visible=100 → 30 本地未挂;归档 500 未拉 → 还有 530 条。
    renderList(users(130), { archivedCount: 500, archivedThroughSeq: 5 });
    expect(screen.getByRole("button", { name: /加载更多历史（还有 530 条）/ })).toBeInTheDocument();
    expect(screen.queryByText(/从云端加载更早的历史/)).toBeNull();
  });

  test("无归档时本地翻页按钮 count 即本地未挂(退化行为不变)", () => {
    renderList(users(130)); // 无 archive prop
    expect(screen.getByRole("button", { name: /加载更多历史（还有 30 条）/ })).toBeInTheDocument();
  });

  test("lossless tape 的隐藏 runtime-event 不占最近100条窗口,首屏仍显示真实回复", () => {
    const visible: ChatMessage[] = [
      mk("user", { id: "u-visible", text: "可见提问", status: "sent", ts: 1 }),
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
      mk("assistant", { id: "a-visible", text: "可见最终答复", ts: 4 }),
    ];
    const hidden = Array.from({ length: 120 }, (_, i) => ({
      id: `runtime-${i}`,
      role: "runtime-event",
      text: "",
      ts: 5 + i,
      _runtimeEvent: { type: "system", subtype: "raw_frame", index: i },
    })) as unknown as ChatMessage[];

    renderList([...visible, ...hidden]);

    expect(screen.getByText("可见提问")).toBeInTheDocument();
    expect(screen.getByText("可见最终答复")).toBeInTheDocument();
    expect(screen.getByText(/已思考/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /加载更多历史/ })).toBeNull();
  });

  test("本地翻尽 + 有归档未拉 → 云端加载按钮,还有 M 条(§5 文案)", () => {
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5 });
    expect(
      screen.getByRole("button", { name: /从云端加载更早的历史（还有 500 条）/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/加载更多历史/)).toBeNull();
  });

  test("本地翻尽 + 无归档 → 无按钮", () => {
    const { container } = renderList(users(3), { archivedCount: 0 });
    expect(container.querySelector("button")).toBeNull();
  });

  test("云端加载中 → 按钮显示「加载中…」且禁用", () => {
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, loading: true });
    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent(/加载中/);
    expect(btn).toBeDisabled();
    // loading 时不显示 §5 文案(避免与 spinner 并存的抖动)。
    expect(screen.queryByText(/从云端加载更早的历史/)).toBeNull();
  });

  test("云端加载失败 → 按钮显示「加载失败，点击重试」且可点(重试)", () => {
    const onLoadOlder = vi.fn();
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, error: true, onLoadOlder });
    const btn = screen.getByRole("button", { name: /加载失败，点击重试/ });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  test("点击云端按钮 → 触发 onLoadOlder", () => {
    const onLoadOlder = vi.fn();
    renderList(users(3), { archivedCount: 500, archivedThroughSeq: 5, onLoadOlder });
    fireEvent.click(screen.getByRole("button", { name: /从云端加载更早的历史/ }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
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
    // 仍是云端态,剩余 = 500-100 = 400,无本地翻页按钮。
    expect(
      screen.getByRole("button", { name: /从云端加载更早的历史（还有 400 条）/ }),
    ).toBeInTheDocument();
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

  test("组内末条流式(sending)→ 整卡「思考中…」,不显示「已思考」", () => {
    renderList(
      [
        mk("user", { id: "u1", text: "q", status: "sent" }),
        think("th1", "**Step one**"),
        think("th2", "**Step two**"),
      ],
      true,
    );
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(screen.queryByText(/已思考/)).toBeNull();
  });

  test("中间夹被跳过的 unknown(goal)行 → 不打断连续性,仍合并成 1 张卡", () => {
    renderList([
      mk("user", { id: "u1", text: "q", status: "sent" }),
      think("th1", "**Alpha**"),
      mk("goal", { id: "g1", text: "目标(v5 不渲染)" }), // messageKind unknown → 渲染 null,透明跳过
      think("th2", "**Beta**"),
    ]);
    expect(screen.getAllByText(/已思考/)).toHaveLength(1);
    // goal 行仍不产出可见内容(消息数量/顺序语义不变,只是被并入连续性判定)。
    expect(screen.queryByText("目标(v5 不渲染)")).toBeNull();
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
    const strong = await screen.findByText("Planning tool usage strategy", {}, { timeout: 5000 });
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
    const s1 = await screen.findByText("Planning explicit collaboration spawn", {}, { timeout: 5000 });
    expect(s1.tagName).toBe("STRONG");
    const s2 = await screen.findByText("Debugging template literal parsing", {}, { timeout: 5000 });
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
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(screen.getByText("推理中...")).toBeInTheDocument();
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
