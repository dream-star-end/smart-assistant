/**
 * oc-connect 确认卡（human-in-the-loop 写操作门）测试。
 *
 * 覆盖：
 *   1. parseOcConnectConfirmation：混杂日志中提取触发对象 / 截断 / 缺字段 / 非确认类型
 *   2. 渲染 + 交互：确认执行 → decide('approve') + 自动发「已确认执行（<短id>）」；
 *      拒绝 → decide('deny') + 「已拒绝（…）」；状态徽标随响应更新
 *   3. 查看完整内容 → getDetail 懒加载，结构化渲染（收件人/主题/正文）
 *   4. 降级：无 connectorConfirm 注入 → 无操作按钮 + 提示；无 sendUserText → 手动跟进文案
 *   5. 过期 → 已过期展示、无操作按钮
 *   6. 与 meta 单一权威的集成：OC_TOOLS 登记 + detectOcCli 识别 oc-connect
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { ConnectorConfirmationDetail, ConnectorConfirmTrigger } from "../../lib/connectors";
import {
  ChatInteractionContext,
  ToolCardActionsContext,
  type ToolCardActions,
} from "./context";
import {
  ConnectorConfirmCard,
  connectorToolCard,
  parseOcConnectConfirmation,
} from "./connectorCards";
import { detectOcCli, OC_TOOLS } from "./meta";

afterEach(cleanup);

const TRIGGER: ConnectorConfirmTrigger = {
  type: "confirmation_required",
  id: "abcd1234-ef56-7890-aaaa-bbbbccccdddd",
  provider: "imap",
  action: "send_email",
  summary: "发送邮件给 boss@example.com：《周报》",
  expiresAt: "2999-01-01T00:00:00.000Z",
};

const TRIGGER_JSON = JSON.stringify({ oc_connect: TRIGGER });

function detailOf(
  overrides: Partial<ConnectorConfirmationDetail> = {},
): ConnectorConfirmationDetail {
  return {
    id: TRIGGER.id,
    provider: "imap",
    action: "send_email",
    summary: TRIGGER.summary,
    detail: { to: ["boss@example.com"], subject: "周报", body: "第一行\n第二行正文内容" },
    status: "pending",
    expiresAt: TRIGGER.expiresAt,
    ...overrides,
  };
}

function renderCard(opts: {
  actions?: ToolCardActions;
  sendUserText?: (t: string) => void;
  trigger?: ConnectorConfirmTrigger;
}) {
  return render(
    <ToolCardActionsContext.Provider value={opts.actions ?? {}}>
      <ChatInteractionContext.Provider value={{ sendUserText: opts.sendUserText }}>
        <ConnectorConfirmCard trigger={opts.trigger ?? TRIGGER} />
      </ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>,
  );
}

describe("parseOcConnectConfirmation", () => {
  test("混杂前后日志时仍能提取触发对象", () => {
    const out = `INFO 正在调用 send_email…\n${TRIGGER_JSON}\n(等待用户确认)`;
    const parsed = parseOcConnectConfirmation(out);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(TRIGGER.id);
    expect(parsed?.provider).toBe("imap");
    expect(parsed?.action).toBe("send_email");
    expect(parsed?.summary).toBe(TRIGGER.summary);
    expect(parsed?.expiresAt).toBe(TRIGGER.expiresAt);
  });

  test("截断的半截 JSON → null(不抛异常)", () => {
    expect(parseOcConnectConfirmation(TRIGGER_JSON.slice(0, TRIGGER_JSON.length - 10))).toBeNull();
  });

  test("缺 id / 非 confirmation_required / 无关输出 → null", () => {
    expect(
      parseOcConnectConfirmation(
        JSON.stringify({ oc_connect: { type: "confirmation_required", provider: "imap" } }),
      ),
    ).toBeNull();
    expect(
      parseOcConnectConfirmation(JSON.stringify({ oc_connect: { type: "result", id: "x" } })),
    ).toBeNull();
    expect(parseOcConnectConfirmation('{"ok":true,"items":[]}')).toBeNull();
    expect(parseOcConnectConfirmation("")).toBeNull();
    expect(parseOcConnectConfirmation(null)).toBeNull();
  });

  test("summary 内含花括号/转义引号不破坏配对提取", () => {
    const tricky = JSON.stringify({
      oc_connect: { ...TRIGGER, summary: '发送 {"嵌套":"值"} 与 \\" 引号' },
    });
    const parsed = parseOcConnectConfirmation(`前导\n${tricky}\n后缀`);
    expect(parsed?.summary).toBe('发送 {"嵌套":"值"} 与 \\" 引号');
  });
});

describe("connectorToolCard 分派", () => {
  test("输出含确认对象 → 渲染确认卡;普通输出 → null(回落通用卡)", () => {
    expect(connectorToolCard({ output: TRIGGER_JSON })).not.toBeNull();
    expect(connectorToolCard({ output: '{"connections":[]}' })).toBeNull();
    expect(connectorToolCard({ output: null })).toBeNull();
  });

  test("meta 单一权威:OC_TOOLS 已登记 oc-connect 且 detectOcCli 识别命令位置调用", () => {
    expect(OC_TOOLS["oc-connect"].label).toBe("应用连接");
    expect(detectOcCli("oc-connect list")).toBe("oc-connect");
    expect(detectOcCli("echo done && oc-connect call imap send_email --account k1")).toBe(
      "oc-connect",
    );
    expect(detectOcCli("echo oc-connect")).toBeNull();
  });
});

describe("ConnectorConfirmCard 交互", () => {
  test("pending:渲染动作中文名 + 摘要 + 确认/拒绝按钮", () => {
    const actions: ToolCardActions = {
      connectorConfirm: { getDetail: vi.fn(), decide: vi.fn() },
    };
    renderCard({ actions });

    expect(screen.getByText(/写操作待确认 · 发送邮件/)).toBeInTheDocument();
    expect(screen.getByText(TRIGGER.summary)).toBeInTheDocument();
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    // 确认码短 id 提示
    expect(screen.getByText(/确认码 abcd1234/)).toBeInTheDocument();
  });

  test("确认执行 → decide('approve') → 状态更新 + 自动发「已确认执行（短id）」", async () => {
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "approved" });
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail: vi.fn(), decide } }, sendUserText });

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(TRIGGER.id, "approve"));
    await waitFor(() => expect(sendUserText).toHaveBeenCalledWith("已确认执行（abcd1234）"));
    expect(await screen.findByText("已确认")).toBeInTheDocument();
    // 终态化:按钮消失
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  });

  test("拒绝 → decide('deny') → 「已拒绝（短id）」+ 已拒绝徽标", async () => {
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "denied" });
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail: vi.fn(), decide } }, sendUserText });

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(sendUserText).toHaveBeenCalledWith("已拒绝（abcd1234）"));
    expect(await screen.findByText("已拒绝")).toBeInTheDocument();
  });

  test("decide 被后端拒绝:错误码映射中文 + 以服务端状态刷新本地态", async () => {
    const decide = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 409, message: "raw", code: "RATE_LIMITED" }));
    const getDetail = vi.fn().mockResolvedValue(detailOf({ status: "expired" }));
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail, decide } }, sendUserText });

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(await screen.findByText("操作过于频繁，请稍后再试")).toBeInTheDocument();
    // 服务端权威状态回写 → 已过期
    expect(await screen.findByText("已过期")).toBeInTheDocument();
    expect(sendUserText).not.toHaveBeenCalled();
  });

  test("查看完整内容:懒加载 getDetail 并结构化渲染(收件人/主题/正文)", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    expect(getDetail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /查看完整内容/ }));
    await waitFor(() => expect(getDetail).toHaveBeenCalledWith(TRIGGER.id));

    expect(await screen.findByText("收件人")).toBeInTheDocument();
    expect(screen.getByText("boss@example.com")).toBeInTheDocument();
    expect(screen.getByText("主题")).toBeInTheDocument();
    expect(screen.getByText("周报")).toBeInTheDocument();
    expect(screen.getByText("正文")).toBeInTheDocument();
    expect(screen.getByText(/第一行/)).toBeInTheDocument();
    expect(screen.getByText(/第二行正文内容/)).toBeInTheDocument();
  });

  test("无 sendUserText 注入:决策成功后给手动跟进降级文案", async () => {
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "approved" });
    renderCard({ actions: { connectorConfirm: { getDetail: vi.fn(), decide } } });

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(await screen.findByText("已确认，请回复助手继续。")).toBeInTheDocument();
  });

  test("无 connectorConfirm 注入(demo/未登录):无操作按钮,给不可操作提示", () => {
    renderCard({});
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.getByText(/此会话中不可操作/)).toBeInTheDocument();
  });

  test("已过期触发对象:显示已过期,无操作按钮", () => {
    renderCard({
      actions: { connectorConfirm: { getDetail: vi.fn(), decide: vi.fn() } },
      trigger: { ...TRIGGER, expiresAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  });
});
