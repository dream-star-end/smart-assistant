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
import type {
  ApiKeySummary,
  ApiKeyUsageRecent,
  ApiKeyUsageReport,
  AuthSession,
} from "../../lib/types";

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
    // 最近明细分页 / 请求审计走的是裸 fetch + 统一鉴权三件套(与 MediaTaskCenter 同一先例)。
    // 这里保留真实语义、只把身份围栏与刷新重放拿掉,断言才能落在**实际请求 URL** 上。
    bearerHeaders: (t: string) => ({ Authorization: `Bearer ${t}` }),
    callWithRefresh: (_a: unknown, make: (t: string) => Promise<Response>) => make("t"),
    jsonOrThrow: async (p: Promise<Response> | Response) => {
      const res = await p;
      if (!res.ok) throw new ApiError({ status: res.status, message: `HTTP ${res.status}` });
      return res.json();
    },
  };
});

import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import { ApiAccessTab, ApiKeyAuditPanel, ApiKeyUsagePanel } from "./ApiAccessTab";
import type { ApiKeyMessageAuditEntry } from "./ApiAccessTab";
import {
  buildCcSwitchDeepLink,
  buildCcSwitchUsageScript,
  claudeCodeExtraEnv,
  familyGuideList,
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
    { id: "cursor-opus-5-high", display_name: "Opus 5 High", engine: "cursor" as const },
    { id: "cursor-sonnet-5-high", display_name: "Sonnet 5 High", engine: "cursor" as const },
    // 单档无思考轴,公开 id 就是家族 id(0280)。
    { id: "cursor-haiku-4.5", display_name: "Haiku 4.5", engine: "cursor" as const },
    // 可用但**不在**默认集里 —— 教程的"当前可用"应把它过滤掉(仍可自行发现使用)。
    {
      id: "cursor-gemini-3.8-flash-low",
      display_name: "Gemini 3.8 Flash Low",
      engine: "cursor" as const,
    },
    { id: "gpt-6-astra", display_name: "GPT-6 Astra", engine: "codex" as const },
  ],
  lockedModels: [],
};

/** 一条最近明细行(id 唯一即可,其它字段取默认)。 */
function recentRow(id: string, over: Partial<ApiKeyUsageRecent> = {}): ApiKeyUsageRecent {
  return {
    id,
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
    ...over,
  };
}

/** 一条审计行。 */
function auditRow(
  id: string,
  over: Partial<ApiKeyMessageAuditEntry> = {},
): ApiKeyMessageAuditEntry {
  return {
    id,
    created_at: "2026-09-06T10:00:00.000Z",
    request_id: `req-${id}`,
    api_key_id: "11",
    requested_model: "sonnet-5",
    model: "cursor-sonnet-5-low",
    effort: "low",
    effort_source: "classifier",
    account_id: null,
    body_sha256: "a".repeat(64),
    body_bytes: 1024,
    message_count: 3,
    tool_count: 0,
    stream: true,
    last_user_message: "帮我看下这段代码",
    last_user_message_truncated: false,
    status: "success",
    terminal_code: null,
    error_message: null,
    duration_ms: 820,
    input_tokens: "3000",
    output_tokens: "200",
    cache_read_tokens: "0",
    cache_write_tokens: "0",
    client_user_agent: "claude-cli/2.1",
    ...over,
  };
}

/** 走过 fetch 的 URL(顺序保留),供断言查询串。 */
let fetched: string[] = [];
/** path 前缀 → 该端点依次返回的 JSON(用完最后一个就一直复用它)。 */
let fetchRoutes: { messages: unknown[]; recent: unknown[] };

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function nextFrom(queue: unknown[]): unknown {
  return queue.length > 1 ? queue.shift() : (queue[0] ?? { entries: [], next_before: null });
}

beforeEach(() => {
  vi.mocked(api.listApiKeys).mockResolvedValue(KEYS);
  vi.mocked(api.getApiKeyUsage).mockResolvedValue(makeReport());
  vi.mocked(api.getPublicModels).mockResolvedValue(PUBLIC_MODELS);
  fetched = [];
  fetchRoutes = {
    messages: [{ entries: [], next_before: null }],
    recent: [{ window: "7d", key_id: null, entries: [], next_before: null }],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.startsWith("/api/me/api-keys/messages"))
        return jsonResponse(nextFrom(fetchRoutes.messages));
      if (url.startsWith("/api/me/api-keys/usage/recent"))
        return jsonResponse(nextFrom(fetchRoutes.recent));
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** 命中某端点的最后一次请求 URL(没有则抛,便于定位)。 */
function lastFetch(prefix: string): string {
  const hit = [...fetched].reverse().find((u) => u.startsWith(prefix));
  if (!hit) throw new Error(`no fetch to ${prefix}; got ${JSON.stringify(fetched)}`);
  return hit;
}

function countFetch(prefix: string): number {
  return fetched.filter((u) => u.startsWith(prefix)).length;
}

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

  test("familyGuideList:未加载/空 → 默认五家族;有列表 → 交集且按默认集顺序;交集为空 → 退回实际列表", () => {
    const DEFAULTS = ["fable-5.1", "opus-5", "opus-4.8", "sonnet-5", "haiku-4.5"];
    // 拉取失败 / 尚未加载 / 空列表 → 静态默认集(说明性质)。
    expect(familyGuideList(null)).toEqual(DEFAULTS);
    expect(familyGuideList([])).toEqual(DEFAULTS);
    // 交集:只留默认集里有的,且顺序按默认集(不是服务端返回顺序)。
    expect(familyGuideList(["grok-4.6", "haiku-4.5", "fable-5.1"])).toEqual([
      "fable-5.1",
      "haiku-4.5",
    ]);
    expect(familyGuideList(DEFAULTS.slice().reverse())).toEqual(DEFAULTS);
    // 默认集里的家族全都不可用(目录换代)→ 退回实际列表,不给一份全是死 id 的清单。
    expect(familyGuideList(["grok-4.6", "gemini-3.8-flash"])).toEqual([
      "grok-4.6",
      "gemini-3.8-flash",
    ]);
  });

  test("深链拒绝缺失/掩码/不完整密钥,有效密钥按 CC Switch V1 编码", () => {
    const base = {
      origin: "https://x.example",
      name: "从简",
      model: "fable-5.1",
      opusModel: "opus-5",
      sonnetModel: "sonnet-5",
      haikuModel: "haiku-4.5",
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
    // opus 位独立于主模型:Claude Code 的 /model opus 走 ANTHROPIC_DEFAULT_OPUS_MODEL。
    expect(p.get("opusModel")).toBe("opus-5");
    expect(p.get("haikuModel")).toBe("haiku-4.5");
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
    // 四个模型位各自独立:主 fable-5.1、opus 位 opus-5、sonnet 位 sonnet-5、轻量位 haiku-4.5。
    expect(env.textContent).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=opus-5\n");
    expect(env.textContent).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=sonnet-5\n");
    expect(env.textContent).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-4.5\n");
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
    expect(cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-5");
    expect(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("haiku-4.5");
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
    // 教程只列「默认集 ∩ 实际可用」:gemini-3.8-flash 虽可用但不在默认集里,不出现在这里。
    const guideEnv = screen.getByTestId("guide-env");
    expect(within(guideEnv).getAllByText("fable-5.1").length).toBe(1);
    expect(within(guideEnv).getAllByText("opus-5").length).toBe(1);
    expect(within(guideEnv).getAllByText("sonnet-5").length).toBe(1);
    expect(within(guideEnv).getAllByText("haiku-4.5").length).toBe(1);
    expect(within(guideEnv).queryByText("gemini-3.8-flash")).not.toBeInTheDocument();
    // opus-4.8 在默认集里但本次列表没有 → 交集里也没有它。
    expect(within(guideEnv).queryByText("opus-4.8")).not.toBeInTheDocument();
    expect(screen.queryByText(/cursor-fable/)).not.toBeInTheDocument();
    expect(screen.queryByText("fable-5.1-low")).not.toBeInTheDocument();
  });

  test("默认模型集:列表拉取失败 → 教程展示五个默认家族;opus 位选 opus-5、轻量位选 haiku-4.5", async () => {
    vi.mocked(api.getPublicModels).mockRejectedValue(new Error("boom"));
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    await waitFor(() => expect(api.getPublicModels).toHaveBeenCalled());
    const guideEnv = screen.getByTestId("guide-env");
    for (const family of ["fable-5.1", "opus-5", "opus-4.8", "sonnet-5", "haiku-4.5"]) {
      expect(within(guideEnv).getAllByText(family).length).toBeGreaterThan(0);
    }
    const env = screen.getByTestId("env-snippet").textContent ?? "";
    expect(env).toContain("ANTHROPIC_MODEL=fable-5.1\n");
    expect(env).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=opus-5\n");
    expect(env).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-4.5\n");
    expect(document.body.textContent).not.toMatch(/cursor/i);
  });

  test("默认集与可用列表求交:只列交集且顺序按默认集,退化位按可用列表回退", async () => {
    // 可用:grok(不在默认集)/ haiku-4.5 / fable-5.1 —— 交集 = fable-5.1, haiku-4.5。
    vi.mocked(api.getPublicModels).mockResolvedValue({
      models: [
        { id: "cursor-grok-4.6-high", display_name: "Grok 4.6", engine: "cursor" as const },
        { id: "cursor-haiku-4.5", display_name: "Haiku 4.5", engine: "cursor" as const },
        { id: "cursor-fable-5.1-high", display_name: "Fable 5.1", engine: "cursor" as const },
      ],
      lockedModels: [],
    });
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    const families = await waitFor(() => {
      const list = screen.getAllByTestId("guide-family").map((el) => el.textContent);
      if (!list.includes("haiku-4.5")) throw new Error("not yet");
      return list;
    });
    expect(families).toEqual(["fable-5.1", "haiku-4.5"]);
    // 主模型仍是 fable-5.1;opus 位默认 opus-5 不可用 → 按 /^(opus|fable)-/ 退到 fable-5.1。
    const env = screen.getByTestId("env-snippet").textContent ?? "";
    expect(env).toContain("ANTHROPIC_MODEL=fable-5.1\n");
    expect(env).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=fable-5.1\n");
    expect(env).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=haiku-4.5\n");
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
    expect(screen.getAllByText("haiku-4.5").length).toBeGreaterThan(0);
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
    // 空态文案除了"空",还要说清为什么空 / 下一步做什么。
    expect(await screen.findByText(/该时段暂无 API Key 用量。/)).toBeInTheDocument();
    expect(screen.getByText(/该时段暂无模型用量。/)).toBeInTheDocument();
    expect(screen.getByText(/该时段暂无请求记录。/)).toBeInTheDocument();
    expect(screen.getByText(/换更长的时间窗口/)).toBeInTheDocument();
  });

  test("最近明细「加载更多」打新端点、结果追加;next_before=null 后换成「已到底」", async () => {
    // 第一页满 50 条 → 才认为可能还有下一页。
    const first = Array.from({ length: 50 }, (_, i) => recentRow(String(900 - i)));
    vi.mocked(api.getApiKeyUsage).mockResolvedValue(makeReport({ recent: first }));
    fetchRoutes.recent = [
      {
        window: "7d",
        key_id: null,
        entries: [recentRow("800", { cost_credits: "77" })],
        next_before: "800",
      },
      { window: "7d", key_id: null, entries: [recentRow("700")], next_before: null },
    ];
    render(<ApiKeyUsagePanel auth={auth} keys={KEYS} />);
    const more = await screen.findByTestId("recent-load-more");
    expect(screen.getByText("已显示 50 条")).toBeInTheDocument();

    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText("已显示 51 条")).toBeInTheDocument());
    // 游标 = 已加载的最后一行 id;窗口一并带上,且默认「全部密钥」时不带 key_id。
    const url = new URL(lastFetch("/api/me/api-keys/usage/recent"), "https://x.example");
    expect(url.pathname).toBe("/api/me/api-keys/usage/recent");
    expect(url.searchParams.get("before")).toBe("851");
    expect(url.searchParams.get("window")).toBe("7d");
    expect(url.searchParams.get("key_id")).toBeNull();
    // 追加的行确实进了表。
    const recent = screen.getByRole("table", { name: /最近 API Key 请求/ });
    expect(within(recent).getByText("77")).toBeInTheDocument();

    // 第二页 next_before=null → 到底,按钮消失换成「已到底」。
    fireEvent.click(screen.getByTestId("recent-load-more"));
    await waitFor(() => expect(screen.getByText("已到底")).toBeInTheDocument());
    expect(screen.queryByTestId("recent-load-more")).not.toBeInTheDocument();
    expect(screen.getByText("已显示 52 条")).toBeInTheDocument();

    // 换窗口 → 重置分页,不再残留上一窗口翻出来的行。
    fireEvent.click(screen.getByRole("tab", { name: "24 小时" }));
    await waitFor(() => expect(screen.getByText("已显示 50 条")).toBeInTheDocument());
  });

  test("第一页不满页时直接判「已到底」,不打分页端点", async () => {
    render(<ApiKeyUsagePanel auth={auth} keys={KEYS} />);
    expect(await screen.findByText("已到底")).toBeInTheDocument();
    expect(screen.queryByTestId("recent-load-more")).not.toBeInTheDocument();
    expect(countFetch("/api/me/api-keys/usage/recent")).toBe(0);
  });

  test("by_model 11 行 → 出现分页,每页 10,能翻到第 2 页", async () => {
    // 用非目录 id:publicCursorModelId 只对真实 cursor 目录项剥前缀,这里要的是"11 行"本身。
    const models = Array.from({ length: 11 }, (_, i) => ({
      model: `m${i}-low`,
      requests: "1",
      input_tokens: "1",
      output_tokens: "1",
      cache_read_tokens: "0",
      cache_write_tokens: "0",
      credits: "1",
    }));
    vi.mocked(api.getApiKeyUsage).mockResolvedValue(makeReport({ by_model: models }));
    render(<ApiKeyUsagePanel auth={auth} keys={KEYS} />);
    const byModel = await screen.findByRole("table", { name: /按模型用量/ });
    expect(within(byModel).getAllByText(/^m\d+-low$/)).toHaveLength(10);
    expect(within(byModel).getByText("m0-low")).toBeInTheDocument();
    expect(within(byModel).queryByText("m10-low")).not.toBeInTheDocument();
    expect(screen.getByText("第 1/2 页")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "按模型·下一页" }));
    await waitFor(() => expect(within(byModel).getByText("m10-low")).toBeInTheDocument());
    expect(within(byModel).getAllByText(/^m\d+-low$/)).toHaveLength(1);
    expect(screen.getByText("第 2/2 页")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按模型·下一页" })).toBeDisabled();

    // by_key 只有 2 行 → 不渲染分页控件(十行以内不加噪音)。
    expect(screen.queryByTestId("pager-按密钥")).not.toBeInTheDocument();
  });
});

describe("ApiKeyAuditPanel · 请求审计", () => {
  test("默认拉 limit=20;「只看失败」开关重新请求且带 errors_only=1", async () => {
    fetchRoutes.messages = [{ entries: [auditRow("501")], next_before: null }];
    render(<ApiKeyAuditPanel auth={auth} keys={KEYS} />);
    await waitFor(() => expect(countFetch("/api/me/api-keys/messages")).toBe(1));
    let url = new URL(lastFetch("/api/me/api-keys/messages"), "https://x.example");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("errors_only")).toBeNull();
    expect(await screen.findByText("帮我看下这段代码")).toBeInTheDocument();
    // 档位 + 来源(0280 的 classifier 侧查询)与耗时可读。
    expect(screen.getByText("low · 分类器")).toBeInTheDocument();
    expect(screen.getByText("820ms")).toBeInTheDocument();
    // 内部 id 不外泄。
    expect(document.body.textContent).not.toMatch(/cursor/i);

    fireEvent.click(screen.getByRole("switch", { name: "只看失败" }));
    await waitFor(() => expect(countFetch("/api/me/api-keys/messages")).toBe(2));
    url = new URL(lastFetch("/api/me/api-keys/messages"), "https://x.example");
    expect(url.searchParams.get("errors_only")).toBe("1");

    // key 筛选也进查询串。
    fireEvent.change(screen.getByRole("combobox", { name: "审计按密钥过滤" }), {
      target: { value: "11" },
    });
    await waitFor(() => expect(countFetch("/api/me/api-keys/messages")).toBe(3));
    url = new URL(lastFetch("/api/me/api-keys/messages"), "https://x.example");
    expect(url.searchParams.get("key_id")).toBe("11");
    expect(url.searchParams.get("errors_only")).toBe("1");
  });

  test("「加载更多」带 before 游标追加;到底后按钮消失", async () => {
    fetchRoutes.messages = [
      { entries: [auditRow("501")], next_before: "501" },
      {
        entries: [auditRow("400", { last_user_message: "第二页的消息" })],
        next_before: null,
      },
    ];
    render(<ApiKeyAuditPanel auth={auth} keys={KEYS} />);
    const more = await screen.findByTestId("audit-load-more");
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText("第二页的消息")).toBeInTheDocument());
    const url = new URL(lastFetch("/api/me/api-keys/messages"), "https://x.example");
    expect(url.searchParams.get("before")).toBe("501");
    await waitFor(() =>
      expect(screen.queryByTestId("audit-load-more")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("已到底")).toBeInTheDocument();
    expect(screen.getByText("已显示 2 条")).toBeInTheDocument();
  });

  test("用户消息含 <script> 时只作为文本渲染,不产生真实节点;长消息可展开", async () => {
    const evil = `<script>alert("xss")</script><img src=x onerror=alert(1)>`;
    const long = `${evil}${"很".repeat(200)}`;
    fetchRoutes.messages = [
      { entries: [auditRow("501", { last_user_message: long })], next_before: null },
    ];
    render(<ApiKeyAuditPanel auth={auth} keys={KEYS} />);
    const pre = await screen.findByTestId("audit-message");
    // 折叠态:截到 120 字 + 省略号。
    expect(pre.textContent?.length).toBe(121);
    expect(pre.textContent).toContain("<script>");
    // 关键:标签是文本,不是 DOM —— 页面里不存在 script / img 节点。
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(pre.innerHTML).toContain("&lt;script&gt;");

    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    await waitFor(() => expect(screen.getByTestId("audit-message").textContent).toBe(long));
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    await waitFor(() =>
      expect(screen.getByTestId("audit-message").textContent?.length).toBe(121),
    );
  });

  test("非 admin(端点 403)整段不渲染;失败态可重试;空态区分「只看失败」", async () => {
    // 403 = 角色变更竞态兜底,与 ApiKeysSection 同策略:隐藏而不是报错。
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { code: "FORBIDDEN" } }),
      } as unknown as Response;
    });
    const view = render(<ApiKeyAuditPanel auth={auth} keys={KEYS} />);
    await waitFor(() => expect(countFetch("/api/me/api-keys/messages")).toBe(1));
    await waitFor(() =>
      expect(document.querySelector("[data-api-key-audit]")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("请求审计")).not.toBeInTheDocument();
    view.unmount();

    // 500 不是隐藏,而是可重试的错误提示。
    let call = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return jsonResponse({ entries: [], next_before: null });
    });
    render(<ApiKeyAuditPanel auth={auth} keys={KEYS} />);
    expect(await screen.findByText("加载请求审计失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/暂无审计记录。/)).toBeInTheDocument();
    // 开「只看失败」后的空态文案不同(告诉用户这是好事 + 怎么看全部)。
    fireEvent.click(screen.getByRole("switch", { name: "只看失败" }));
    expect(await screen.findByText(/该筛选下没有失败请求/)).toBeInTheDocument();
  });
});

describe("ApiKeysSection · 密钥列表分页", () => {
  test("11 把密钥 → 每页 10 条 + 翻页;第 2 页显示剩下 1 条", async () => {
    const many: ApiKeySummary[] = Array.from({ length: 11 }, (_, i) => ({
      ...KEYS[0],
      id: String(100 + i),
      label: `key-${i}`,
    }));
    vi.mocked(api.listApiKeys).mockResolvedValue(many);
    render(<ApiAccessTab auth={auth} />);
    await keyRow("100");
    const list = screen.getByTestId("api-keys-list");
    expect(within(list).getAllByText(/^key-\d+$/)).toHaveLength(10);
    expect(within(list).queryByText("key-10")).not.toBeInTheDocument();
    expect(screen.getByText("第 1/2 页")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "密钥列表·下一页" }));
    await waitFor(() => expect(within(list).getByText("key-10")).toBeInTheDocument());
    expect(within(list).getAllByText(/^key-\d+$/)).toHaveLength(1);
  });

  test("≤10 把密钥不渲染分页控件", async () => {
    render(<ApiAccessTab auth={auth} />);
    await keyRow("11");
    expect(screen.queryByTestId("pager-密钥列表")).not.toBeInTheDocument();
  });
});
