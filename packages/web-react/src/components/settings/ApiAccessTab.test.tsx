/**
 * ApiAccessTab / ApiKeysSection 测试。
 *
 * 覆盖:
 *   1. 列表渲染 + 新增字段(已禁用徽标、上限进度);
 *   2. 重命名 / 禁用 / 设置上限 → updateApiKey 调用形状(PATCH body 由 api 层映射,这里只断言参数);
 *   3. 消耗统计面板:窗口切换与 key 过滤触发 getApiKeyUsage、stat 卡 / by_key / by_model / 最近请求渲染。
 *
 * api 网络层全 mock;useChart 换成 no-op 桩(jsdom 无 canvas)。
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ApiKeySummary, ApiKeyUsageReport, AuthSession } from "../../lib/types";

vi.mock("../charts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../charts")>();
  return { ...actual, useChart: () => {} };
});

vi.mock("../../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(init: { status: number; message: string }) {
      super(init.message);
      this.status = init.status;
    }
  }
  return {
    ApiError,
    api: {
      listApiKeys: vi.fn(),
      createApiKey: vi.fn(),
      deleteApiKey: vi.fn(),
      updateApiKey: vi.fn(),
      getApiKeyUsage: vi.fn(),
    },
    apiErrorMessage: (_e: unknown, fallback: string) => fallback,
  };
});

import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ApiAccessTab, ApiKeyUsagePanel } from "./ApiAccessTab";
import { limitPercent } from "./ApiKeysSection";

const auth: AuthSession = createMemoryAuthSession(() => {}, "t");

/** 密钥列表中某一行(用 data-api-key-id 定位,避免与消耗统计表里同名文本撞车)。 */
async function keyRow(id: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`li[data-api-key-id="${id}"]`);
    if (!el) throw new Error(`key row ${id} not rendered`);
    return el;
  });
}

const KEYS: ApiKeySummary[] = [
  {
    id: "11",
    label: "my-cli",
    keyPrefix: "oc-cc.abcd",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: "2026-09-06T10:00:00.000Z",
    disabledAt: null,
    creditLimit: "1000",
    spentCredits: "850",
  },
  {
    id: "12",
    label: "paused",
    keyPrefix: "oc-cc.wxyz",
    createdAt: "2026-09-02T00:00:00.000Z",
    lastUsedAt: null,
    disabledAt: "2026-09-05T00:00:00.000Z",
    creditLimit: null,
    spentCredits: "0",
  },
];

function makeReport(over: Partial<ApiKeyUsageReport> = {}): ApiKeyUsageReport {
  return {
    window: "7d",
    key_id: null,
    summary: {
      requests: "42",
      input_tokens: "120000",
      output_tokens: "8000",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      credits: "1234",
    },
    trend: [
      { bucket: "2026-09-05", requests: "20", credits: "600" },
      { bucket: "2026-09-06", requests: "22", credits: "634" },
    ],
    by_key: [
      {
        api_key_id: "11",
        label: "my-cli",
        key_prefix: "oc-cc.abcd",
        revoked: false,
        disabled: false,
        requests: "40",
        credits: "1200",
        input_tokens: "119000",
        output_tokens: "7900",
        last_used_at: "2026-09-06T10:00:00.000Z",
      },
      {
        api_key_id: "9",
        label: "old-key",
        key_prefix: "oc-cc.gone",
        revoked: true,
        disabled: false,
        requests: "2",
        credits: "34",
        input_tokens: "1000",
        output_tokens: "100",
        last_used_at: "2026-09-04T10:00:00.000Z",
      },
    ],
    by_model: [
      {
        model: "cursor-sonnet-5-low",
        requests: "42",
        input_tokens: "120000",
        output_tokens: "8000",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        credits: "1234",
      },
    ],
    recent: [
      {
        id: "900",
        created_at: "2026-09-06T10:00:00.000Z",
        api_key_id: "11",
        label: "my-cli",
        model: "cursor-sonnet-5-low",
        input_tokens: "3000",
        output_tokens: "200",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cost_credits: "31",
        status: "success",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(api.listApiKeys).mockResolvedValue(KEYS);
  vi.mocked(api.getApiKeyUsage).mockResolvedValue(makeReport());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("limitPercent", () => {
  test("字符串大数按 BigInt 精确算并夹到 100;无上限 / 非法项返回 null", () => {
    expect(limitPercent("850", "1000")).toBe(85);
    expect(limitPercent("1500", "1000")).toBe(100);
    expect(limitPercent("0", "1000")).toBe(0);
    expect(limitPercent("10", null)).toBeNull();
    expect(limitPercent("10", "0")).toBeNull();
    expect(limitPercent("x", "1000")).toBeNull();
    expect(limitPercent("99999999999999999999", "100000000000000000000")).toBe(99);
  });
});

describe("ApiAccessTab · 密钥列表与自管", () => {
  test("渲染列表:上限进度、已禁用徽标、Claude Code 接入片段", async () => {
    render(<ApiAccessTab auth={auth} />);
    const row = await keyRow("11");
    expect(within(row).getByText("my-cli")).toBeInTheDocument();
    expect(within(await keyRow("12")).getByText("paused")).toBeInTheDocument();
    expect(within(await keyRow("12")).getByText("已禁用")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "已用 85%" })).toBeInTheDocument();
    expect(screen.getByText("/ 上限 1,000")).toBeInTheDocument();
    expect(screen.getByText("设置上限")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "禁用该密钥" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "启用该密钥" })).not.toBeChecked();
    expect(screen.getByText(/接入本地 Claude Code/)).toBeInTheDocument();
  });

  test("重命名:Enter 提交 → updateApiKey({label})", async () => {
    vi.mocked(api.updateApiKey).mockResolvedValue({ ...KEYS[0], label: "renamed" });
    render(<ApiAccessTab auth={auth} />);
    const row = await keyRow("11");
    fireEvent.click(within(row).getByRole("button", { name: "重命名" }));
    const input = within(row).getByRole("textbox", { name: "密钥名称" });
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith(auth, "11", { label: "renamed" }),
    );
    expect(await within(row).findByText("renamed")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "密钥名称" })).not.toBeInTheDocument();
  });

  test("禁用开关 → updateApiKey({disabled:true});禁用 key 的开关反向恢复", async () => {
    vi.mocked(api.updateApiKey).mockResolvedValue({
      ...KEYS[0],
      disabledAt: "2026-09-07T00:00:00.000Z",
    });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    fireEvent.click(screen.getByRole("switch", { name: "禁用该密钥" }));
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith(auth, "11", { disabled: true }),
    );
    // 两个 key 都成了禁用态。
    await waitFor(() =>
      expect(within(screen.getByTestId("api-keys-list")).getAllByText("已禁用")).toHaveLength(2),
    );

    vi.mocked(api.updateApiKey).mockResolvedValue({ ...KEYS[1], disabledAt: null });
    fireEvent.click(screen.getAllByRole("switch", { name: "启用该密钥" })[1]);
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith(auth, "12", { disabled: false }),
    );
  });

  test("设置上限:只接受正整数;留空清除 → creditLimit:null", async () => {
    vi.mocked(api.updateApiKey).mockResolvedValue({ ...KEYS[1], creditLimit: "500" });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("12");
    fireEvent.click(screen.getByText("设置上限"));
    const input = screen.getByRole("textbox", { name: "积分上限(留空为不限)" });
    fireEvent.change(input, { target: { value: "5a00" } });
    expect(input).toHaveValue("500");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith(auth, "12", { creditLimit: "500" }),
    );
    expect(await screen.findByText("/ 上限 500")).toBeInTheDocument();

    // 再改为留空 → 清除。
    vi.mocked(api.updateApiKey).mockResolvedValue({ ...KEYS[1], creditLimit: null });
    fireEvent.click(screen.getByText("/ 上限 500"));
    const again = screen.getByRole("textbox", { name: "积分上限(留空为不限)" });
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() =>
      expect(api.updateApiKey).toHaveBeenCalledWith(auth, "12", { creditLimit: null }),
    );
  });

  test("列表 403 时整段隐藏(角色变更竞态兜底)", async () => {
    const { ApiError } = await import("../../lib/api");
    vi.mocked(api.listApiKeys).mockRejectedValue(
      new ApiError({ status: 403, message: "forbidden" }),
    );
    render(<ApiAccessTab auth={auth} />);
    await waitFor(() => expect(api.listApiKeys).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/新密钥名称/)).not.toBeInTheDocument(),
    );
  });
});

describe("ApiKeyUsagePanel · 消耗统计", () => {
  test("默认 7d 全部密钥;渲染 stat 卡、按密钥(含已撤销)、按模型、最近请求", async () => {
    render(<ApiKeyUsagePanel auth={auth} keys={KEYS} />);
    await waitFor(() => expect(api.getApiKeyUsage).toHaveBeenCalledWith(auth, "7d", undefined));

    const credits = await screen.findByText("1,234 积分");
    expect(credits).toHaveClass("text-accent");
    const statGrid = credits.closest<HTMLElement>(".grid")!;
    expect(within(statGrid).getByText("42")).toBeInTheDocument();
    expect(within(statGrid).getByText("12万")).toBeInTheDocument();

    const byKey = screen.getByRole("table", { name: /按密钥用量/ });
    expect(within(byKey).getByText("my-cli")).toBeInTheDocument();
    expect(within(byKey).getByText("old-key")).toBeInTheDocument();
    expect(within(byKey).getByText("已撤销")).toBeInTheDocument();
    expect(within(byKey).getByText("启用中")).toBeInTheDocument();

    const byModel = screen.getByRole("table", { name: /按模型用量/ });
    expect(within(byModel).getByText("cursor-sonnet-5-low")).toBeInTheDocument();

    const recent = screen.getByRole("table", { name: /最近 API Key 请求/ });
    expect(within(recent).getByText("成功")).toBeInTheDocument();
    expect(within(recent).getByText("31")).toBeInTheDocument();
  });

  test("切窗口与按密钥过滤都重新请求;下拉包含全部 key(禁用带标注)", async () => {
    render(<ApiKeyUsagePanel auth={auth} keys={KEYS} />);
    await waitFor(() => expect(api.getApiKeyUsage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("tab", { name: "24 小时" }));
    await waitFor(() => expect(api.getApiKeyUsage).toHaveBeenCalledWith(auth, "24h", undefined));

    const select = screen.getByRole("combobox", { name: "按密钥过滤" });
    expect(within(select).getByRole("option", { name: "全部密钥" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "my-cli" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "paused(已禁用)" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "11" } });
    await waitFor(() => expect(api.getApiKeyUsage).toHaveBeenCalledWith(auth, "24h", "11"));
  });

  test("加载失败可重试;空数据显示空态", async () => {
    vi.mocked(api.getApiKeyUsage)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeReport({ by_key: [], by_model: [], recent: [], trend: [] }));
    render(<ApiKeyUsagePanel auth={auth} keys={[]} />);
    expect(await screen.findByText("加载 API Key 消耗统计失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("该时段暂无 API Key 用量。")).toBeInTheDocument();
    expect(screen.getByText("该时段暂无模型用量。")).toBeInTheDocument();
    expect(screen.getByText("该时段暂无请求记录。")).toBeInTheDocument();
  });
});
