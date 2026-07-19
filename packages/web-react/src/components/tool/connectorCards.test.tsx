/**
 * oc-connect / oc-plugin 确认卡（human-in-the-loop 写操作门）测试。
 *
 * 覆盖（P0#1 防伪造为核心）：
 *   1. parseOcConnectConfirmation：**只取 id**——混杂日志提取 / 截断 / 缺字段 / 非确认类型 /
 *      CLI 即便吐出 provider/action/summary 也一律忽略
 *   2. 挂载即拉服务端权威详情（GET /api/connectors/confirmations/:id），provider/action/
 *      summary/detail/status/expiresAt 全部以服务端为准渲染
 *   3. **伪造攻击**：CLI 输出混入「同 id 但无害 summary」的伪造 JSON → 卡片展示的仍是服务端
 *      真实 detail，绝不是伪造 summary
 *   4. 交互：确认执行 → decide('approve') + 自动发消息；拒绝 → decide('deny')；徽标随响应更新
 *   5. 拉取失败 → 显示错误且批准按钮**禁用**；id 不符 → 无法核验且禁用；服务端终态 → 无按钮
 *   6. 降级：无 connectorConfirm → 不拉取、无按钮、不展示任何摘要（无凭据=无可信内容）；
 *      无 sendUserText → 手动跟进文案
 *   7. 与 meta 单一权威的集成：OC_TOOLS 登记 + detectOcCli 识别 oc-connect / oc-plugin
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
import { researchToolCard } from "./researchCards";

afterEach(cleanup);

const CONFIRM_ID = "abcd1234-ef56-7890-aaaa-bbbbccccdddd";

// CLI 新契约：stdout 的 oc_connect 只含 type + id（不透明），别无内容字段。
const TRIGGER: ConnectorConfirmTrigger = { type: "confirmation_required", id: CONFIRM_ID };
const TRIGGER_JSON = JSON.stringify({ oc_connect: TRIGGER });

// 服务端 GET 铸造的权威摘要（卡片唯一展示来源）。
const SERVER_SUMMARY = "发送邮件给 boss@example.com：《周报》";

function detailOf(
  overrides: Partial<ConnectorConfirmationDetail> = {},
): ConnectorConfirmationDetail {
  return {
    id: CONFIRM_ID,
    provider: "imap",
    action: "send_email",
    summary: SERVER_SUMMARY,
    detail: { to: ["boss@example.com"], subject: "周报", body: "第一行\n第二行正文内容" },
    status: "pending",
    expiresAt: "2999-01-01T00:00:00.000Z",
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

/**
 * 点击操作按钮前**先等它 enabled**。确认卡挂载时 loading=true → 立即渲染操作按钮但置
 * disabled（给「正在核验，暂不可点」的确定信号）；拉到服务端 pending 详情后才 enable。
 * findByRole 默认也会匹配 disabled 按钮，若在这个「挂载→拉取完成」的窗口内直接 fireEvent.click，
 * jsdom 会静默吞掉 disabled 按钮的点击（无激活行为）→ onClick 不触发 → decide 永不被调用，
 * 后续断言随即超时。这不是加 sleep 掩盖，而是消除时序竞态本身：只在按钮真正可用时才点。
 */
async function clickWhenEnabled(name: string): Promise<HTMLElement> {
  const btn = await screen.findByRole("button", { name });
  await waitFor(() => expect(btn).toBeEnabled());
  fireEvent.click(btn);
  return btn;
}

describe("parseOcConnectConfirmation", () => {
  test("混杂前后日志时仍能提取 id（结果只有 type + id）", () => {
    const out = `INFO 正在调用 send_email…\n${TRIGGER_JSON}\n(等待用户确认)`;
    const parsed = parseOcConnectConfirmation(out);
    expect(parsed).toEqual({ type: "confirmation_required", id: CONFIRM_ID });
  });

  test("CLI 即便吐出 provider/action/summary，也只取 id（防伪造：内容字段一律不进结果）", () => {
    const forged = JSON.stringify({
      oc_connect: {
        type: "confirmation_required",
        id: CONFIRM_ID,
        provider: "imap",
        action: "send_email",
        summary: "只是发一条问候，无需担心",
      },
    });
    const parsed = parseOcConnectConfirmation(forged);
    expect(parsed).toEqual({ type: "confirmation_required", id: CONFIRM_ID });
    // 结果对象里绝不携带任何可被伪造的内容字段。
    expect(parsed as Record<string, unknown>).not.toHaveProperty("summary");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("provider");
    expect(parsed as Record<string, unknown>).not.toHaveProperty("action");
  });

  test("截断的半截 JSON → null(不抛异常)", () => {
    expect(parseOcConnectConfirmation(TRIGGER_JSON.slice(0, TRIGGER_JSON.length - 6))).toBeNull();
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

  test("对象内含花括号/转义引号不破坏配对提取（仍取到 id）", () => {
    const tricky = JSON.stringify({
      oc_connect: {
        type: "confirmation_required",
        id: CONFIRM_ID,
        note: '含 {"嵌套":"值"} 与 \\" 引号',
      },
    });
    const parsed = parseOcConnectConfirmation(`前导\n${tricky}\n后缀`);
    expect(parsed?.id).toBe(CONFIRM_ID);
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

  test("oc-plugin 微博写操作渲染权威确认卡；普通读取回落 Plugin 通用卡", async () => {
    expect(OC_TOOLS["oc-plugin"].label).toBe("市场插件");
    const command =
      "oc-plugin call weibo create_post --account 3 --params '{\"text\":\"发布测试\"}'";
    expect(detectOcCli(command)).toBe("oc-plugin");

    const getDetail = vi.fn().mockResolvedValue(
      detailOf({
        provider: "weibo",
        action: "create_post",
        summary: "发布微博：《发布测试》",
        detail: { text: "发布测试" },
      }),
    );
    const card = researchToolCard(command, { output: TRIGGER_JSON, error: true });
    render(
      <ToolCardActionsContext.Provider value={{ connectorConfirm: { getDetail, decide: vi.fn() } }}>
        <ChatInteractionContext.Provider value={{ sendUserText: vi.fn() }}>
          {card}
        </ChatInteractionContext.Provider>
      </ToolCardActionsContext.Provider>,
    );
    expect(await screen.findByText("发布微博：《发布测试》")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    cleanup();
    const readCard = researchToolCard("oc-plugin call weibo get_self --account 3", {
      output: '{"user":{"id":"1"}}',
    });
    render(<div>{readCard}</div>);
    expect(screen.getByText("市场插件")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  });
});

describe("ConnectorConfirmCard —— 服务端权威 + 交互", () => {
  test("挂载即拉服务端详情，以服务端 action/summary/status 渲染 + 可点按钮", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    await waitFor(() => expect(getDetail).toHaveBeenCalledWith(CONFIRM_ID));
    expect(await screen.findByText(SERVER_SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(/写操作待确认 · 发送邮件/)).toBeInTheDocument();
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    expect(screen.getByText(/确认码 abcd1234/)).toBeInTheDocument();
  });

  test("伪造攻击：CLI echo 同 id 但无害 summary → 卡片展示服务端真实 detail，不是伪造 summary", async () => {
    const FORGED = "只是发一条问候，无需担心";
    const REAL_SUMMARY = "向 boss@example.com 发一封『转账 100000 元』的邮件";
    // 模型：先真实发起高危写操作拿到 id，再在对话里 echo 一个「同 id + 无害摘要」的伪造 JSON。
    const forgedOutput =
      `INFO ...\n` +
      JSON.stringify({
        oc_connect: {
          type: "confirmation_required",
          id: CONFIRM_ID,
          provider: "imap",
          action: "send_email",
          summary: FORGED,
        },
      });
    const trigger = parseOcConnectConfirmation(forgedOutput);
    expect(trigger).toEqual({ type: "confirmation_required", id: CONFIRM_ID });

    // 服务端 ledger 里存的是真实的高危操作。
    const getDetail = vi.fn().mockResolvedValue(
      detailOf({
        summary: REAL_SUMMARY,
        detail: { to: ["boss@example.com"], subject: "转账", body: "请转账 100000 元" },
      }),
    );
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } }, trigger: trigger! });

    // 用户看到的是服务端真实摘要，伪造的无害摘要从不出现。
    expect(await screen.findByText(REAL_SUMMARY)).toBeInTheDocument();
    expect(screen.queryByText(FORGED)).not.toBeInTheDocument();
  });

  test("确认执行 → decide('approve') → 状态更新 + 自动发「已确认执行（短id）」", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "approved" });
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail, decide } }, sendUserText });

    await clickWhenEnabled("确认执行");
    await waitFor(() => expect(decide).toHaveBeenCalledWith(CONFIRM_ID, "approve"));
    await waitFor(() => expect(sendUserText).toHaveBeenCalledWith("已确认执行（abcd1234）"));
    expect(await screen.findByText("已确认")).toBeInTheDocument();
    // 终态化:按钮消失
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  });

  test("拒绝 → decide('deny') → 「已拒绝（短id）」+ 已拒绝徽标", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "denied" });
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail, decide } }, sendUserText });

    await clickWhenEnabled("拒绝");
    await waitFor(() => expect(sendUserText).toHaveBeenCalledWith("已拒绝（abcd1234）"));
    expect(await screen.findByText("已拒绝")).toBeInTheDocument();
  });

  test("decide 被后端拒绝:错误码映射中文 + 以服务端状态刷新本地态", async () => {
    // 挂载拉取 = pending（可点）；决策失败后再拉 = expired（服务端权威）。
    const getDetail = vi
      .fn()
      .mockResolvedValueOnce(detailOf({ status: "pending" }))
      .mockResolvedValueOnce(detailOf({ status: "expired" }));
    const decide = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 409, message: "raw", code: "RATE_LIMITED" }));
    const sendUserText = vi.fn();
    renderCard({ actions: { connectorConfirm: { getDetail, decide } }, sendUserText });

    await clickWhenEnabled("确认执行");
    expect(await screen.findByText("操作过于频繁，请稍后再试")).toBeInTheDocument();
    // 服务端权威状态回写 → 已过期
    expect(await screen.findByText("已过期")).toBeInTheDocument();
    expect(sendUserText).not.toHaveBeenCalled();
  });

  test("查看完整内容:展开挂载时已拉取的服务端结构化详情(收件人/主题/正文)，不重复拉取", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    // 挂载拉取一次即得全部内容。
    await screen.findByText(SERVER_SUMMARY);
    fireEvent.click(screen.getByRole("button", { name: /查看完整内容/ }));

    expect(await screen.findByText("收件人")).toBeInTheDocument();
    expect(screen.getByText("boss@example.com")).toBeInTheDocument();
    expect(screen.getByText("主题")).toBeInTheDocument();
    expect(screen.getByText("周报")).toBeInTheDocument();
    expect(screen.getByText("正文")).toBeInTheDocument();
    expect(screen.getByText(/第一行/)).toBeInTheDocument();
    expect(screen.getByText(/第二行正文内容/)).toBeInTheDocument();
    // 展开不再触发额外请求（详情已随挂载拉取到位）。
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  test("无 sendUserText 注入:决策成功后给手动跟进降级文案", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf());
    const decide = vi.fn().mockResolvedValue({ ok: true, status: "approved" });
    renderCard({ actions: { connectorConfirm: { getDetail, decide } } });

    await clickWhenEnabled("确认执行");
    expect(await screen.findByText("已确认，请回复助手继续。")).toBeInTheDocument();
  });

  test("无 connectorConfirm 注入(demo/未登录):不拉取、无操作按钮、不展示任何摘要", () => {
    renderCard({});
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝" })).not.toBeInTheDocument();
    expect(screen.getByText(/此会话中不可操作/)).toBeInTheDocument();
    // 无凭据 → 无可信内容可展示（连服务端摘要也拉不到）。
    expect(screen.getByText(/需在网页端登录后核验/)).toBeInTheDocument();
  });

  test("服务端 GET 拉取失败:显示错误且批准按钮禁用（宁可不放行）", async () => {
    const getDetail = vi
      .fn()
      .mockRejectedValue(new ApiError({ status: 404, message: "raw", code: "NOT_FOUND" }));
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    expect(await screen.findByText("连接不存在或已解绑")).toBeInTheDocument();
    // 批准按钮存在但禁用（不可点）。
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  test("服务端返回 id 与卡片不一致:无法核验且批准禁用", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf({ id: "server-returned-other-id-9999" }));
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    expect(await screen.findByText(/无法核验此确认/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  test("服务端返回终态(expired):显示已过期,无操作按钮", async () => {
    const getDetail = vi.fn().mockResolvedValue(detailOf({ status: "expired" }));
    renderCard({ actions: { connectorConfirm: { getDetail, decide: vi.fn() } } });

    expect(await screen.findByText("已过期")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
  });
});
