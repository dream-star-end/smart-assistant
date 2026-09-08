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
      getPublicModels: vi.fn(),
    },
    apiErrorMessage: (_e: unknown, fallback: string) => fallback,
  };
});

import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ApiAccessTab, ApiKeyUsagePanel } from "./ApiAccessTab";
import {
  buildCcSwitchDeepLink,
  buildCcSwitchUsageScript,
  claudeCodeExtraEnv,
  limitPercent,
  pickDefaultModel,
} from "./ApiKeysSection";

const COMPLETE_KEY = `oc-cc.abcd1234.${"a1".repeat(24)}`;

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

/**
 * 站内公开模型列表:外接引擎行带内部 id(cursor-*、含思考档位),页面必须只展示公开**家族** id
 * (无前缀、无档位;同家族多档位折叠成一项)。
 */
const PUBLIC_MODELS = {
  models: [
    { id: "cursor-fable-5.1-high", display_name: "Fable 5.1 High", engine: "cursor" as const },
    { id: "cursor-fable-5.1-low", display_name: "Fable 5.1 Low", engine: "cursor" as const },
    { id: "cursor-sonnet-5-high", display_name: "Sonnet 5 High", engine: "cursor" as const },
    {
      id: "cursor-gemini-3.8-flash-low",
      display_name: "Gemini 3.8 Flash Low",
      engine: "cursor" as const,
    },
    { id: "gpt-6-astra", display_name: "GPT-6 Astra", engine: "codex" as const },
  ],
  lockedModels: [],
};

beforeEach(() => {
  vi.mocked(api.listApiKeys).mockResolvedValue(KEYS);
  vi.mocked(api.getApiKeyUsage).mockResolvedValue(makeReport());
  vi.mocked(api.getPublicModels).mockResolvedValue(PUBLIC_MODELS);
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

describe("pickDefaultModel / buildCcSwitchDeepLink", () => {
  test("首选在列表里就用首选;列表缺失/为空用首选兜底;否则按家族正则退到列表项", () => {
    expect(pickDefaultModel(null, "fable-5.1")).toBe("fable-5.1");
    expect(pickDefaultModel([], "fable-5.1")).toBe("fable-5.1");
    expect(pickDefaultModel(["sonnet-5", "fable-5.1"], "fable-5.1")).toBe("fable-5.1");
    expect(pickDefaultModel(["sonnet-5", "opus-5"], "fable-5.1", /^(fable|opus)-/)).toBe("opus-5");
    expect(pickDefaultModel(["sonnet-5"], "fable-5.1", /^(fable|opus)-/)).toBe("sonnet-5");
    // 轻量模型:家族 id 无 -low 后缀可依赖,按 gemini/-flash 匹配。
    expect(pickDefaultModel(["fable-5.1", "gemini-3.8-flash"], "x", /^gemini-|-flash(-|$)/)).toBe(
      "gemini-3.8-flash",
    );
  });

  test("深链拒绝缺失/掩码/不完整密钥,有效密钥按 CC Switch V1 编码", () => {
    const base = {
      origin: "https://x.example",
      name: "从简",
      model: "fable-5.1",
      opusModel: "fable-5.1",
      sonnetModel: "sonnet-5",
      haikuModel: "gemini-3.8-flash",
    };
    const noKey = buildCcSwitchDeepLink(base);
    expect(noKey).toBeNull();
    for (const apiKey of ["", "  ", "oc-cc.<你的密钥>", "oc-cc.abcd1234.ff", "****"]) {
      expect(buildCcSwitchDeepLink({ ...base, apiKey })).toBeNull();
    }
    const withKey = buildCcSwitchDeepLink({ ...base, apiKey: ` ${COMPLETE_KEY}\n` })!;
    expect(withKey.startsWith("ccswitch://v1/import?")).toBe(true);
    const p = new URL(withKey).searchParams;
    expect(p.get("resource")).toBe("provider");
    expect(p.get("app")).toBe("claude");
    expect(p.get("name")).toBe("从简");
    expect(p.get("endpoint")).toBe("https://x.example/api/anthropic");
    // 模型名是家族 id,不带思考档位:深度由用户在 Claude Code 里设置。
    expect(p.get("model")).toBe("fable-5.1");
    expect(p.get("haikuModel")).toBe("gemini-3.8-flash");
    expect(p.get("apiKey")).toBe(COMPLETE_KEY);
    expect(withKey).not.toMatch(/cursor/i);
    expect(withKey).not.toMatch(/-(low|medium|high|xhigh|max)(&|$)/);
    // 额外 env 经 config(base64 JSON {env})携带,CC Switch 以它为底叠加 URL 参数写 settings。
    expect(p.get("configFormat")).toBe("json");
    const cfg = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(p.get("config")!), (c) => c.charCodeAt(0))),
    ) as { env: Record<string, string> };
    expect(cfg.env).toEqual(claudeCodeExtraEnv());
    expect(cfg.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe("1");
    // config 只带额外 env,不重复标准字段(URL 参数才是权威,避免两处不一致)。
    expect(cfg.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(cfg.env.ANTHROPIC_MODEL).toBeUndefined();
    // 导入后立即切换为当前供应商:不带 enabled=true 时 CC Switch 只加进列表,
    // settings.json 仍指向旧供应商/旧密钥 → 本地 Claude Code 401(OCV5-171 后续)。
    expect(p.get("enabled")).toBe("true");
    // 用量查询随深链一并开启:脚本 base64(CC Switch decode_base64_param 接受标准/URL-safe)。
    expect(p.get("usageEnabled")).toBe("true");
    expect(p.get("usageAutoInterval")).toBe("30");
    const script = new TextDecoder().decode(
      Uint8Array.from(atob(p.get("usageScript")!), (c) => c.charCodeAt(0)),
    );
    expect(script).toBe(buildCcSwitchUsageScript());
  });

  test("CC Switch 用量脚本:请求 {{baseUrl}}/v1/usage,extractor 把余额/上限映射成 remaining/used/total", () => {
    const script = buildCcSwitchUsageScript();
    expect(script).toContain('"{{baseUrl}}/v1/usage"');
    expect(script).toContain('"Bearer {{apiKey}}"');
    expect(script).not.toMatch(/cursor/i);
    // 与 CC Switch 一样:替换模板变量后 eval 得到 { request, extractor }。
    const cfg = new Function(
      `return ${script
        .replace(/\{\{baseUrl\}\}/g, "https://x.example/api/anthropic")
        .replace(/\{\{apiKey\}\}/g, COMPLETE_KEY)};`,
    )() as {
      request: { url: string; method: string; headers: Record<string, string> };
      extractor: (r: unknown) => Record<string, unknown>;
    };
    expect(cfg.request.url).toBe("https://x.example/api/anthropic/v1/usage");
    expect(cfg.request.method).toBe("GET");
    expect(cfg.request.headers.Authorization).toBe(`Bearer ${COMPLETE_KEY}`);
    const noLimit = cfg.extractor({
      object: "usage",
      unit: "credits",
      balance: { spendable: "12345" },
      key: { label: "MacBook", spent_credits: "200", credit_limit: null, is_valid: true },
      window: { range: "30d", requests: "12" },
    });
    expect(noLimit).toMatchObject({
      isValid: true,
      planName: "MacBook",
      remaining: 12345,
      used: 200,
      total: -1,
      unit: "积分",
      extra: "近 30 天 12 次请求",
    });
    const withLimit = cfg.extractor({
      object: "usage",
      balance: { spendable: "99999" },
      key: { label: "k", spent_credits: "900", credit_limit: "1000", is_valid: true },
      window: {},
    });
    expect(withLimit).toMatchObject({ remaining: 100, used: 900, total: 1000 });
    const exhausted = cfg.extractor({
      object: "usage",
      balance: { spendable: "0" },
      key: { label: "k", spent_credits: "0", credit_limit: null, is_valid: false },
      window: {},
    });
    expect(exhausted.isValid).toBe(false);
    expect(exhausted.invalidMessage).toMatch(/余额不足|上限/);
    const denied = cfg.extractor({ error: { code: "UNAUTHORIZED", message: "container identity verification failed" } });
    expect(denied).toEqual({ isValid: false, invalidMessage: "container identity verification failed" });
  });
});

describe("ApiAccessTab · 密钥列表与自管", () => {
  test("渲染列表:上限进度、已禁用徽标、接入教程", async () => {
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
    expect(screen.getByText(/用 CC Switch 一键接入/)).toBeInTheDocument();
    expect(screen.getByText(/手动接入本地 Claude Code/)).toBeInTheDocument();
    // 2026-09-08:用量查询教程 + 401 / Auth conflict 排查。
    const usageGuide = screen.getByTestId("guide-usage");
    expect(within(usageGuide).getByText(/在 CC Switch 里查看余额与用量/)).toBeInTheDocument();
    expect(
      within(usageGuide).getAllByText(`GET ${window.location.origin}/api/anthropic/v1/usage`).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("usage-script").textContent).toContain("{{baseUrl}}/v1/usage");
    const trouble = screen.getByTestId("guide-troubleshoot");
    expect(within(trouble).getByText(/401 \/ Auth conflict/)).toBeInTheDocument();
    expect(within(trouble).getByText(/Both a token and an API key are set/)).toBeInTheDocument();
    expect(within(trouble).getByText(/'--settings' 不是内部或外部命令/)).toBeInTheDocument();
    // 深链尾注:导入即切换 + 重开终端 + 清残留环境变量。
    expect(screen.getByText(/直接切换为 Claude Code 当前供应商/)).toBeInTheDocument();
  });

  test("用量脚本可整段复制(与深链里 base64 的脚本同源)", async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboard },
      configurable: true,
    });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    const guide = screen.getByTestId("guide-usage");
    guide.setAttribute("open", "");
    fireEvent.click(within(guide).getByRole("button", { name: "复制" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    expect(clipboard.mock.calls[0][0]).toBe(buildCcSwitchUsageScript());
  });

  test("接入教程:公开模型 id(无引擎前缀)、模型查询地址、CC Switch 深链;整页无 cursor 字样", async () => {
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    await waitFor(() => expect(api.getPublicModels).toHaveBeenCalledWith(auth));

    // 环境变量片段:默认模型来自可用列表(公开家族 id,无档位),base URL 指向 /api/anthropic。
    const env = await waitFor(() => {
      const el = screen.getByTestId("env-snippet");
      if (!/ANTHROPIC_MODEL=fable-5\.1\n/.test(el.textContent ?? "")) throw new Error("not yet");
      return el;
    });
    expect(env.textContent).toContain(`ANTHROPIC_BASE_URL=${window.location.origin}/api/anthropic`);
    expect(env.textContent).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=sonnet-5\n");
    expect(env.textContent).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=gemini-3.8-flash\n");
    expect(env.textContent).toContain("ANTHROPIC_AUTH_TOKEN='oc-cc.<你的密钥>");
    // 让 Claude Code 对本站(非内置)模型名也发送 effort。
    expect(env.textContent).toContain("export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1");
    expect(env.textContent).not.toMatch(/MODEL=[^\n]*-(low|medium|high|xhigh|max)\n/);

    // CC Switch JSON 配置:同一组值。
    const cfg = JSON.parse(screen.getByTestId("ccswitch-config").textContent ?? "{}") as {
      env: Record<string, string>;
    };
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe(`${window.location.origin}/api/anthropic`);
    expect(cfg.env.ANTHROPIC_MODEL).toBe("fable-5.1");
    expect(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("gemini-3.8-flash");
    expect(cfg.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe("1");
    // 思考深度说明:在 Claude Code 里自己设;带档位后缀的旧写法仍可用于钉死档位。
    const effortGuide = screen.getByTestId("guide-effort");
    expect(effortGuide.textContent).toContain("/effort");
    expect(effortGuide.textContent).toContain("CLAUDE_CODE_EFFORT_LEVEL");
    expect(effortGuide.textContent).toContain("fable-5.1-high");

    // 缺少明文时不生成可点击的坏链接,也不让用户到接收端才发现错误。
    const link = screen.getByTestId("ccswitch-deeplink");
    expect(link).toBeDisabled();
    expect(link).not.toHaveAttribute("href");
    expect(screen.getByText(/请先创建新密钥或粘贴已有的完整密钥/)).toBeInTheDocument();
    // 模型查询接口地址出现在教程里。
    expect(
      screen.getAllByText(`${window.location.origin}/api/anthropic/v1/models`).length,
    ).toBeGreaterThan(0);

    // 产品硬要求:API 接入页任何可见文本都不出现 cursor(CSS class 不算文本)。
    expect(document.body.textContent).not.toMatch(/cursor/i);
    // 由模型列表推导的家族名以公开 id 展示;两个 fable-5.1 档位折叠成一项。
    const guideEnv = screen.getByTestId("guide-env");
    expect(within(guideEnv).getAllByText("fable-5.1").length).toBe(1);
    expect(within(guideEnv).getAllByText("sonnet-5").length).toBe(1);
    expect(within(guideEnv).getAllByText("gemini-3.8-flash").length).toBe(1);
    expect(screen.queryByText(/cursor-fable/)).not.toBeInTheDocument();
    expect(screen.queryByText("fable-5.1-low")).not.toBeInTheDocument();
  });

  test("创建密钥后:片段 / JSON / 深链都带上明文,深链提示「已包含刚创建的密钥」", async () => {
    vi.mocked(api.createApiKey).mockResolvedValue({
      id: "13",
      label: "new-one",
      keyPrefix: "zzzz9999",
      plaintext: "oc-cc.zzzz9999.0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: "2026-09-07T00:00:00.000Z",
    });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    fireEvent.change(screen.getByPlaceholderText(/新密钥名称/), { target: { value: "new-one" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await keyRow("13");
    await waitFor(() => expect(api.createApiKey).toHaveBeenCalledWith(auth, "new-one"));
    const link = screen.getByTestId("ccswitch-deeplink") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("apiKey=oc-cc.zzzz9999.");
    // 供应商名必须是 ASCII:CC Switch Windows「打开终端」会把 name 派生的路径写进 .bat,中文名会让 cmd 解析失败。
    const importedName = new URL(link.getAttribute("href")!).searchParams.get("name")!;
    expect(importedName).toBe("Clarvy");
    expect(importedName).toMatch(/^[\x20-\x7e]+$/);
    expect(screen.getByText(/已包含刚创建的密钥/)).toBeInTheDocument();
    expect(screen.getByTestId("env-snippet").textContent).toContain(
      "ANTHROPIC_AUTH_TOKEN='oc-cc.zzzz9999.",
    );
  });

  test("粘贴已有密钥:完整值导入/复制,显示脱敏,清空后禁用,重新挂载不保存", async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboard },
      configurable: true,
    });
    const view = render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    fireEvent.click(screen.getByRole("tab", { name: "使用已有密钥" }));
    const input = screen.getByLabelText("完整 API Key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "oc-cc.abcd1234.****" } });
    expect(screen.getByTestId("ccswitch-deeplink")).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(input, { target: { value: ` ${COMPLETE_KEY}\n` } });
    const link = screen.getByTestId("ccswitch-deeplink");
    expect(new URL(link.getAttribute("href")!).searchParams.get("apiKey")).toBe(COMPLETE_KEY);
    expect(document.body.textContent).not.toContain(COMPLETE_KEY);
    const guide = screen.getByTestId("guide-manual-ccswitch");
    fireEvent.click(within(guide).getByText("手动配置 CC Switch · JSON"));
    // jsdom 不模拟 details 的 toggle,显式打开以验证同一复制按钮。
    guide.setAttribute("open", "");
    fireEvent.click(within(guide).getByRole("button", { name: "复制" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    expect(JSON.parse(clipboard.mock.calls[0][0]).env.ANTHROPIC_AUTH_TOKEN).toBe(COMPLETE_KEY);
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByTestId("ccswitch-deeplink")).toBeDisabled();
    fireEvent.change(input, { target: { value: COMPLETE_KEY } });
    view.unmount();
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    fireEvent.click(screen.getByRole("tab", { name: "使用已有密钥" }));
    expect(screen.getByLabelText("完整 API Key")).toHaveValue("");
    expect(screen.getByTestId("ccswitch-deeplink")).not.toHaveAttribute("href");
  });

  test("已知密钥停用时阻止导入,启用后恢复", async () => {
    const paused = { ...KEYS[1], keyPrefix: "abcd1234" };
    vi.mocked(api.listApiKeys).mockResolvedValue([paused]);
    vi.mocked(api.updateApiKey).mockResolvedValue({ ...paused, disabledAt: null });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("12");
    fireEvent.click(screen.getByRole("tab", { name: "使用已有密钥" }));
    fireEvent.change(screen.getByLabelText("完整 API Key"), { target: { value: COMPLETE_KEY } });
    expect(screen.getByTestId("ccswitch-deeplink")).toBeDisabled();
    expect(screen.getByText(/该密钥已停用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "启用该密钥" }));
    await waitFor(() => expect(screen.getByTestId("ccswitch-deeplink")).toHaveAttribute("href"));
  });

  test("创建失败不产生无效链接,显示可重试错误", async () => {
    vi.mocked(api.createApiKey).mockRejectedValueOnce(new Error("offline"));
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    fireEvent.change(screen.getByPlaceholderText(/新密钥名称/), { target: { value: "MacBook" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("创建失败")).toBeInTheDocument();
    expect(screen.getByTestId("ccswitch-deeplink")).toBeDisabled();
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
  });

  test("公开模型列表加载失败 → 教程退到静态默认值,不报错", async () => {
    vi.mocked(api.getPublicModels).mockRejectedValue(new Error("boom"));
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    await waitFor(() => expect(api.getPublicModels).toHaveBeenCalled());
    expect(screen.getByTestId("env-snippet").textContent).toContain("ANTHROPIC_MODEL=fable-5.1\n");
    expect(screen.getAllByText("gemini-3.8-flash").length).toBeGreaterThan(0);
    expect(screen.queryByText("加载 API Key 失败")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/cursor/i);
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

    // 后端返回内部 id(cursor-*),页面只展示公开 id。
    const byModel = screen.getByRole("table", { name: /按模型用量/ });
    expect(within(byModel).getByText("sonnet-5-low")).toBeInTheDocument();
    expect(within(byModel).queryByText(/cursor/i)).not.toBeInTheDocument();

    const recent = screen.getByRole("table", { name: /最近 API Key 请求/ });
    expect(within(recent).getByText("成功")).toBeInTheDocument();
    expect(within(recent).getByText("31")).toBeInTheDocument();
    expect(within(recent).getByText("sonnet-5-low")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/cursor/i);
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
