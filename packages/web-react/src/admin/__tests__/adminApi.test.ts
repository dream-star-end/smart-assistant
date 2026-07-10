import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * adminApi 与 lib/api 的鉴权原语（callWithRefresh / jsonOrThrow / throwApi）耦合，且
 * access token 是模块级状态。每个用例 vi.resetModules() + 动态 import 拿到干净的模块图，
 * 避免上个用例刷新出的 token 泄漏到下个用例。全程只 mock 全局 fetch。
 */

type FakeInit = { method?: string; headers?: Record<string, string>; body?: string };

function fakeRes(opts: { status?: number; json?: unknown; text?: string; requestId?: string }) {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>();
  if (opts.requestId) headers.set("x-request-id", opts.requestId);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

async function loadAdminApi() {
  vi.resetModules();
  return import("../lib/adminApi");
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adminGet", () => {
  test("拼 /api/admin 前缀 + 查询串，返回解析 JSON", async () => {
    const { adminGet } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ json: { total: 42 } }));

    const data = await adminGet<{ total: number }>("/stats/dau", { window: "7d", empty: "" });
    expect(data).toEqual({ total: 42 });

    const [url] = fetchMock.mock.calls[0] as [string, FakeInit];
    expect(url).toBe("/api/admin/stats/dau?window=7d");
  });

  test("以 /api 开头的绝对路径原样使用（不加 admin 前缀）", async () => {
    const { adminGet } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ json: { ok: true } }));
    await adminGet("/api/me");
    const [url] = fetchMock.mock.calls[0] as [string, FakeInit];
    expect(url).toBe("/api/me");
  });

  test("401 → 透明刷新 → 用新 token 重放", async () => {
    const { adminGet } = await loadAdminApi();
    fetchMock
      // 首次 admin 请求：401（token 为空串）
      .mockResolvedValueOnce(fakeRes({ status: 401, json: { error: "unauthorized" } }))
      // 刷新：换到 newtok
      .mockResolvedValueOnce(
        fakeRes({ json: { access_token: "newtok", access_exp: 9999, remember: true } }),
      )
      // 重放：200
      .mockResolvedValueOnce(fakeRes({ json: { value: "ok" } }));

    const data = await adminGet<{ value: string }>("/users");
    expect(data).toEqual({ value: "ok" });

    // 3 次调用：admin(401) → refresh → admin(replay)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshCall = fetchMock.mock.calls[1] as [string, FakeInit];
    expect(refreshCall[0]).toBe("/api/auth/refresh");
    const replayCall = fetchMock.mock.calls[2] as [string, FakeInit];
    expect(replayCall[0]).toBe("/api/admin/users");
    expect(replayCall[1].headers?.Authorization).toBe("Bearer newtok");
  });

  test("commercial 错误信封 → ApiError（status/code/issues）", async () => {
    const { adminGet, ApiError } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(
      fakeRes({
        status: 400,
        requestId: "req-1",
        json: {
          error: { code: "bad_input", message: "参数错误", issues: [{ path: "email", message: "必填" }] },
        },
      }),
    );
    await expect(adminGet("/users")).rejects.toMatchObject({ status: 400, code: "bad_input" });
    // 单独取 instanceof + issue 提取
    try {
      fetchMock.mockResolvedValueOnce(
        fakeRes({
          status: 400,
          json: { error: { code: "bad_input", message: "x", issues: [{ path: "email", message: "必填" }] } },
        }),
      );
      await adminGet("/users");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).issue("email")).toBe("必填");
    }
  });

  test("gateway 字符串错误信封 → ApiError.message", async () => {
    const { adminGet, ApiError } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ status: 404, json: { error: "not found" } }));
    await expect(adminGet("/x")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("adminSend", () => {
  test("带 body 时序列化 + content-type", async () => {
    const { adminSend } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ json: { ok: true } }));
    await adminSend("POST", "/users/u1/credits", { amount: 100 });
    const [url, init] = fetchMock.mock.calls[0] as [string, FakeInit];
    expect(url).toBe("/api/admin/users/u1/credits");
    expect(init.method).toBe("POST");
    expect(init.headers?.["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ amount: 100 }));
  });
});

describe("adminText", () => {
  test("返回纯文本", async () => {
    const { adminText } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ text: "a,b,c\n1,2,3" }));
    const csv = await adminText("/ledger/export", { reason: "topup" });
    expect(csv).toBe("a,b,c\n1,2,3");
    const [url] = fetchMock.mock.calls[0] as [string, FakeInit];
    expect(url).toBe("/api/admin/ledger/export?reason=topup");
  });

  test("非 2xx → ApiError", async () => {
    const { adminText, ApiError } = await loadAdminApi();
    fetchMock.mockResolvedValueOnce(fakeRes({ status: 500, json: { error: "boom" } }));
    await expect(adminText("/ledger/export")).rejects.toBeInstanceOf(ApiError);
  });
});
