/**
 * Non-first-screen projects / assets / payment / subscription REST implementations.
 * Loaded on demand via `projectsApi` lazy proxies so `orgBilling` and payment/asset
 * endpoints stay out of the first-screen static closure.
 */
import type {
  AuthSession,
  HupiCreateResult,
  PaymentOrder,
  PaymentPlan,
  CreateProjectAssetInput,
  PatchProjectAssetInput,
  ProjectAsset,
  SubscriptionPlanWire,
  OrgPlan,
} from "../types";
import { normalizeOrgPlan } from "../orgBilling";
import {
  callWithRefresh,
  assertAuthResponseCurrent,
  sleep,
  bearerHeaders,
  parseRetryAfter,
  throwApi,
  jsonOrThrow,
  fetchWithExecutionGuard,
} from "./http";

/** 资产写接口回 `{ asset }`，早期契约回裸对象；两种都收。 */
function unwrapProjectAsset(body: { asset?: ProjectAsset } & Partial<ProjectAsset>): ProjectAsset {
  return (body.asset ?? body) as ProjectAsset;
}

/** 订阅/升档下单响应 → HupiCreateResult（与 hupi/create 同形，复用 QR + 订单轮询）。 */
function parseSubscriptionOrder(p: Promise<Response>): Promise<HupiCreateResult> {
  return jsonOrThrow<{
    ok: boolean;
    data: {
      order_no: string;
      qrcode_url: string;
      mobile_url: string | null;
      amount_cents: string;
      credits: string;
      expires_at: string;
    };
  }>(p).then((b) => ({
    orderNo: b.data.order_no,
    qrcodeUrl: b.data.qrcode_url,
    mobileUrl: b.data.mobile_url,
    amountCents: b.data.amount_cents,
    credits: b.data.credits,
    expiresAt: b.data.expires_at,
  }));
}

export const projectsLazyImpl = {
  // ── 项目资产（侧栏项目下聚合上传资料 + 会话产出）──

  /**
   * 列出某项目的资产。`projectId` 省略 / null → `?projectId=none`（未分组 / default 组）。
   */
  listProjectAssets: (a: AuthSession, projectId?: string | null): Promise<ProjectAsset[]> => {
    const q =
      projectId == null || projectId === ""
        ? "projectId=none"
        : `projectId=${encodeURIComponent(projectId)}`;
    return jsonOrThrow<{ assets: ProjectAsset[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/project-assets?${q}`, { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.assets || []);
  },

  createProjectAsset: (a: AuthSession, input: CreateProjectAssetInput): Promise<ProjectAsset> =>
    jsonOrThrow<{ asset?: ProjectAsset } & Partial<ProjectAsset>>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/project-assets", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then(unwrapProjectAsset),

  patchProjectAsset: (
    a: AuthSession,
    assetId: string,
    patch: PatchProjectAssetInput,
  ): Promise<ProjectAsset> =>
    jsonOrThrow<{ asset?: ProjectAsset } & Partial<ProjectAsset>>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/project-assets/${encodeURIComponent(assetId)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ).then(unwrapProjectAsset),

  /** 产出物同一源路径的全部版本，新→旧。上传或单版本产出只回它自己。 */
  listProjectAssetVersions: (a: AuthSession, assetId: string): Promise<ProjectAsset[]> =>
    jsonOrThrow<{ versions: ProjectAsset[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/project-assets/${encodeURIComponent(assetId)}/versions`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => b.versions || []),

  /**
   * 把某个旧版本恢复成最新版本：服务端用它的字节再登记一个新版本，已有版本不动。
   * `created=false` 表示它本来就是最新版本。
   */
  restoreProjectAssetVersion: (
    a: AuthSession,
    assetId: string,
  ): Promise<{ asset: ProjectAsset; created: boolean }> =>
    jsonOrThrow<{ asset: ProjectAsset; created: boolean }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/project-assets/${encodeURIComponent(assetId)}/restore`, {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  /** DELETE 约定 204 / 空体；200+JSON 也收。 */
  deleteProjectAsset: (a: AuthSession, assetId: string): Promise<void> =>
    callWithRefresh(a, (t) =>
      fetchWithExecutionGuard(`/api/project-assets/${encodeURIComponent(assetId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    ).then(async (res) => {
      if (res.status === 204 || res.status === 205) {
        assertAuthResponseCurrent(res);
        return undefined;
      }
      await jsonOrThrow(res);
      return undefined;
    }),

  /**
   * 按签名 URL 取媒体二进制（GET /api/media-signed，公开端点，无需鉴权头）。
   * 多数场景下 mediaSign 返回的 URL 直接挂到元素 src 即可；此 helper 仅用于需要
   * 程序化拿到 Blob 的场景（如下载 / 转存）。
   * 冷启容器未就绪 → 503 + Retry-After：自动按 Retry-After 退避重试（上限 maxRetries）。
   */
  async fetchSignedMedia(
    signedUrl: string,
    opts?: { maxRetries?: number; signal?: AbortSignal },
  ): Promise<Blob> {
    const maxRetries = opts?.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const res = await fetchWithExecutionGuard(signedUrl, { headers: { Accept: "*/*" }, signal: opts?.signal });
      if (res.ok) return res.blob();
      // 容器冷启：503 + Retry-After（见 commercial handleMediaSigned ensureContainerReady）。
      if (res.status === 503 && attempt < maxRetries) {
        const retryAfterSec = parseRetryAfter(res) ?? 2;
        await sleep(retryAfterSec * 1000, opts?.signal);
        continue;
      }
      await throwApi(res);
    }
  },

  // ── 充值 / 计费（虎皮椒扫码，commercial REST） ────────────────────────────

  /**
   * 充值套餐列表（GET /api/payment/plans）。公开端点，可选带 Bearer（登录用户首充档
   * 按是否用过过滤）。金额/积分均字符串大数。
   */
  async listPlans(a?: AuthSession): Promise<PaymentPlan[]> {
    const run = (t?: string) =>
      fetchWithExecutionGuard("/api/payment/plans", {
        credentials: "include",
        headers: t ? bearerHeaders(t) : { Accept: "application/json" },
      });
    const res = a ? await callWithRefresh(a, (t) => run(t)) : await run();
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{ code: string; label: string; amount_cents: string; credits: string }>;
      };
    }>(res);
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      label: p.label,
      amountCents: p.amount_cents,
      credits: p.credits,
    }));
  },

  /**
   * 创建虎皮椒充值订单（POST /api/payment/hupi/create，Bearer）。
   * 返回扫码 URL + 订单号（随后用 getOrder 轮询到账）。
   * 409 FIRST_TOPUP_USED = 老用户企图复用首充档（经 ApiError 抛）。
   */
  createHupiOrder: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        qrcode_url: string;
        mobile_url: string | null;
        amount_cents: string;
        credits: string;
        expires_at: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/payment/hupi/create", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      qrcodeUrl: b.data.qrcode_url,
      mobileUrl: b.data.mobile_url,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
    })),

  /**
   * 查询订单（GET /api/payment/orders/:orderNo，Bearer）。轮询用：status 转 'paid'
   * 即到账。404 ORDER_NOT_FOUND（非本人 / 不存在）经 ApiError 抛。
   */
  getOrder: (a: AuthSession, orderNo: string): Promise<PaymentOrder> =>
    jsonOrThrow<{
      ok: boolean;
      data: {
        order_no: string;
        status: string;
        amount_cents: string;
        credits: string;
        expires_at: string;
        paid_at: string | null;
        created_at: string;
        provider: string;
      };
    }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/payment/orders/${encodeURIComponent(orderNo)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then((b) => ({
      orderNo: b.data.order_no,
      status: b.data.status,
      amountCents: b.data.amount_cents,
      credits: b.data.credits,
      expiresAt: b.data.expires_at,
      paidAt: b.data.paid_at,
      createdAt: b.data.created_at,
      provider: b.data.provider,
    })),

  // ── 月度订阅（0096，commercial REST） ──────────────────────────────────────

  /** 套餐档列表（GET /api/subscription/plans，公开）。金额/积分字符串大数。 */
  async listSubscriptionPlans(): Promise<SubscriptionPlanWire[]> {
    const b = await jsonOrThrow<{
      ok: boolean;
      data: {
        plans: Array<{
          code: string;
          name: string;
          price_cents: string;
          monthly_credits: string;
          period_days: number;
          tier: number;
        }>;
      };
    }>(fetchWithExecutionGuard("/api/subscription/plans", { headers: { Accept: "application/json" } }));
    return (b.data?.plans || []).map((p) => ({
      code: p.code,
      name: p.name,
      priceCents: p.price_cents,
      monthlyCredits: p.monthly_credits,
      periodDays: p.period_days,
      tier: p.tier,
    }));
  },

  /**
   * 企业套餐档(GET /api/subscription/plans?scope=org,公开;登录不必需)——落地页锚点价用。
   * 定价本就是公开信息,故走公开端点。响应形容错:兼容 `{ ok, data: { plans } }` 包裹与
   * 裸 `{ plans }`;字段名经 normalizeOrgPlan 归一(含 min_seats)。失败/空由调用方静态兜底。
   */
  async listOrgPlansPublic(): Promise<OrgPlan[]> {
    const b = await jsonOrThrow<{
      ok?: boolean;
      plans?: unknown[];
      data?: { plans?: unknown[] };
    }>(fetchWithExecutionGuard("/api/subscription/plans?scope=org", { headers: { Accept: "application/json" } }));
    const raw = Array.isArray(b.data?.plans) ? b.data.plans : Array.isArray(b.plans) ? b.plans : [];
    return raw.map(normalizeOrgPlan);
  },

  /** 购买/续费某档（POST /api/subscription/subscribe，Bearer）→ 虎皮椒扫码（同 hupi/create 形）。 */
  subscribe: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/subscription/subscribe", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 升档（补差价，POST /api/subscription/upgrade，Bearer）→ 扫码。 */
  upgradeSubscription: (a: AuthSession, planCode: string): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/subscription/upgrade", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: planCode }),
        }),
      ),
    ),

  /** 购买积分加量包（进期内桶，POST /api/subscription/pack，Bearer）→ 扫码。v5 专属，与 v3 隔离。 */
  buyPack: (a: AuthSession): Promise<HupiCreateResult> =>
    parseSubscriptionOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/subscription/pack", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: "{}",
        }),
      ),
    ),
};
