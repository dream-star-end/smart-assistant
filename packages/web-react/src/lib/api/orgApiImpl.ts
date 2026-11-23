/**
 * 企业版 (P3.1) org 自助后台 REST 实现。
 * 从 api.ts 首屏静态闭包拆出，经 `createLazyApiDomain` 按需动态加载（连同 `orgBilling` 一起离开首屏）。
 */
import type {
  AuthSession,
  OrgSummary,
  OrgMember,
  OrgInvitation,
  OrgRole,
  OrgUsageReport,
  OrgUsageWindow,
  OrgInvoiceProfile,
  OrgInvoiceProfileInput,
  OrgInvoiceRequest,
  OrgTopupResult,
  OrgOrder,
  OrgLedgerRow,
  OrgSkillsResponse,
  OrgPlan,
  OrgSubscriptionInfo,
  OrgPayResult,
} from "../types";
import { normalizeOrgPlan, normalizeOrgSubscription } from "../orgBilling";
import { callWithRefresh, bearerHeaders, jsonOrThrow , fetchWithExecutionGuard } from "./http";

/**
 * 企业席位订单下单响应 → OrgPayResult。与批次 F issueOrderQr 同形：
 * `{ ok, data: { order_no, qrcode_url, mobile_url, amount_cents, credits, expires_at } }`。
 * 归一为 {orderNo, qr, mobileUrl};到账轮询走 getOrder。
 */
function parseOrgOrder(p: Promise<Response>): Promise<OrgPayResult> {
  return jsonOrThrow<{
    ok?: boolean;
    data?: {
      order_no: string;
      qrcode_url: string;
      mobile_url: string | null;
      amount_cents?: string;
    };
  }>(p).then((b) => ({
    orderNo: b.data?.order_no ?? "",
    qr: b.data?.qrcode_url ?? "",
    mobileUrl: b.data?.mobile_url ?? null,
    amountCents: b.data?.amount_cents,
  }));
}

export const orgApiImpl = {
  /** GET /api/org 概要(member+)。403=无 org 归属 / org 停用。 */
  getOrg: (a: AuthSession): Promise<OrgSummary> =>
    jsonOrThrow<{ org: OrgSummary }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.org),

  // ── 成员(A 批次后端已就绪) ──────────────────────────────────────────
  listOrgMembers: (a: AuthSession): Promise<OrgMember[]> =>
    jsonOrThrow<{ members: OrgMember[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/members", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.members),

  patchOrgMember: (
    a: AuthSession,
    uid: string,
    patch: {
      org_role?: OrgRole;
      billing_enabled?: boolean;
      status?: "active" | "suspended";
      /** 财务委派(三期):仅 owner 可改。 */
      billing_delegate?: boolean;
      /** 月度组织用量限额(积分;null=不限,字符串大数或数值;admin 可改)。 */
      monthly_org_budget?: string | number | null;
    },
  ): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/org/members/${encodeURIComponent(uid)}`, {
          method: "PATCH",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(patch),
        }),
      ),
    ).then(() => undefined),

  removeOrgMember: (a: AuthSession, uid: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/org/members/${encodeURIComponent(uid)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  listOrgInvitations: (a: AuthSession): Promise<OrgInvitation[]> =>
    jsonOrThrow<{ invitations: OrgInvitation[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invitations", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.invitations),

  createOrgInvitation: (a: AuthSession, email: string, orgRole: OrgRole): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invitations", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ email, org_role: orgRole }),
        }),
      ),
    ).then(() => undefined),

  revokeOrgInvitation: (a: AuthSession, id: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/org/invitations/${encodeURIComponent(id)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  /** POST /api/org/invitations/accept(受邀者尚非成员,仅 requireAuth)。 */
  acceptOrgInvitation: (
    a: AuthSession,
    token: string,
  ): Promise<{ org_id: string; org_role: OrgRole }> =>
    jsonOrThrow<{ joined: boolean; org_id: string; org_role: OrgRole }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invitations/accept", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ token }),
        }),
      ),
    ).then((b) => ({ org_id: b.org_id, org_role: b.org_role })),

  // ── 报表(D 批次,本文件权威) ────────────────────────────────────────
  getOrgUsage: (a: AuthSession, window: OrgUsageWindow): Promise<OrgUsageReport> =>
    jsonOrThrow<OrgUsageReport>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/org/usage?window=${encodeURIComponent(window)}`, {
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ),

  // ── 发票(D 批次,本文件权威) ────────────────────────────────────────
  getOrgInvoiceProfile: (a: AuthSession): Promise<OrgInvoiceProfile | null> =>
    jsonOrThrow<{ profile: OrgInvoiceProfile | null }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invoice-profile", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.profile),

  putOrgInvoiceProfile: (
    a: AuthSession,
    input: OrgInvoiceProfileInput,
  ): Promise<OrgInvoiceProfile> =>
    jsonOrThrow<{ profile: OrgInvoiceProfile }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invoice-profile", {
          method: "PUT",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify(input),
        }),
      ),
    ).then((b) => b.profile),

  listOrgInvoices: (a: AuthSession): Promise<OrgInvoiceRequest[]> =>
    jsonOrThrow<{ invoices: OrgInvoiceRequest[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invoices", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.invoices),

  createOrgInvoice: (a: AuthSession, orderIds: string[]): Promise<OrgInvoiceRequest> =>
    jsonOrThrow<{ invoice: OrgInvoiceRequest }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/invoices", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ order_ids: orderIds }),
        }),
      ),
    ).then((b) => b.invoice),

  // ── 充值(统一支付契约;topup 返 {ok,data:{order_no,qrcode_url,mobile_url}},轮询到账) ──
  orgTopup: (a: AuthSession, amountCents: string): Promise<OrgTopupResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/topup", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ amount_cents: amountCents }),
        }),
      ),
    ),

  /** GET /api/org/balance → {credits}(批次 B)。轮询到账用。 */
  getOrgBalance: (a: AuthSession): Promise<string> =>
    jsonOrThrow<{ credits: string }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/balance", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.credits),

  listOrgOrders: (a: AuthSession): Promise<OrgOrder[]> =>
    jsonOrThrow<{ rows: OrgOrder[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/orders", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.rows ?? []),

  listOrgLedger: (a: AuthSession): Promise<OrgLedgerRow[]> =>
    jsonOrThrow<{ rows: OrgLedgerRow[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/ledger", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => b.rows ?? []),

  // ── 技能(批次 C 契约) ───────────────────────────────────────────────
  getOrgSkills: (a: AuthSession): Promise<OrgSkillsResponse> =>
    jsonOrThrow<OrgSkillsResponse>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/skills", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({ installed: b.installed ?? [], available: b.available ?? [] })),

  installOrgSkill: (a: AuthSession, slug: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/skills/install", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ slug }),
        }),
      ),
    ).then(() => undefined),

  uninstallOrgSkill: (a: AuthSession, slug: string): Promise<void> =>
    jsonOrThrow<unknown>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard(`/api/org/skills/${encodeURIComponent(slug)}`, {
          method: "DELETE",
          credentials: "include",
          headers: bearerHeaders(t),
        }),
      ),
    ).then(() => undefined),

  // ── 席位订阅 + 自助开通(二期批次 F 契约;已按 F 实际响应形对齐,normalizeOrg* 适配字段名)──

  /** GET /api/org/plans:企业套餐档(无 org 也可读,创建向导用)。normalizeOrgPlan 适配字段名。 */
  getOrgPlans: (a: AuthSession): Promise<OrgPlan[]> =>
    jsonOrThrow<{ plans?: unknown[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/plans", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => (Array.isArray(b.plans) ? b.plans : []).map(normalizeOrgPlan)),

  /** POST /api/org/provision:自助开通(组织名+档+席位)→ 扫码。401 未登录;已有 org → 结构化错。 */
  provisionOrg: (
    a: AuthSession,
    input: { orgName: string; planCode: string; seats: number },
  ): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/provision", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({
            org_name: input.orgName,
            plan_code: input.planCode,
            seats: input.seats,
          }),
        }),
      ),
    ),

  /** GET /api/org/subscription:当前订阅 + 档列表(member 可读)。normalizeOrg* 适配。 */
  getOrgSubscription: (a: AuthSession): Promise<OrgSubscriptionInfo> =>
    jsonOrThrow<{ subscription?: unknown; plans?: unknown[] }>(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/subscription", { credentials: "include", headers: bearerHeaders(t) }),
      ),
    ).then((b) => ({
      subscription: normalizeOrgSubscription(b.subscription),
      plans: (Array.isArray(b.plans) ? b.plans : []).map(normalizeOrgPlan),
    })),

  /** POST /api/org/subscribe(owner):订阅 / 续费(档+**总席位**)→ 扫码。403 非 owner。 */
  subscribeOrg: (
    a: AuthSession,
    input: { planCode: string; seats: number },
  ): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/subscribe", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ plan_code: input.planCode, seats: input.seats }),
        }),
      ),
    ),

  /** POST /api/org/seats(owner):加席。**seats = 席位增量(>0)**,对齐 F createOrgSeatsOrder
   *  「席位增量」语义(kind='upgrade',整份即时入池,period 不变)。403 非 owner。 */
  addOrgSeats: (a: AuthSession, seatsDelta: number): Promise<OrgPayResult> =>
    parseOrgOrder(
      callWithRefresh(a, (t) =>
        fetchWithExecutionGuard("/api/org/seats", {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t, true),
          body: JSON.stringify({ seats: seatsDelta }),
        }),
      ),
    ),
};
