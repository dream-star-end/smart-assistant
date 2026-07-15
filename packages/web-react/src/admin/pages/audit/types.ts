// 审计页第二/三/四层数据形状（以 packages/commercial/src/http/admin/audit.ts 的 handler 为准）。
// 第一层（管理操作 admin_audit）行结构仍在 AdminAuditTab.tsx；此处只承载整改批新增的三面。

// ─── 安全事件（GET /api/admin/security-events） ─────────────────────
/** 已知类型：管理员绕过与普通用户被防火墙阻断。 */
export type SecurityEventType = "route_bypass" | "route_blocked";

export interface SecurityEventRow {
  id: string;
  type: string;
  actor_user_id: string | null;
  target: string | null;
  detail: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface SecurityEventsResp {
  rows: SecurityEventRow[];
  next_before: string | null;
}

/** 已知事件类型 → 中文标签；未知类型回落原样显示。 */
export const SECURITY_EVENT_TYPE_LABELS: Record<string, string> = {
  route_bypass: "路由放行",
  route_blocked: "路由拦截",
};

// ─── 主机审计（GET /api/admin/host-audit） ──────────────────────────
// 注意：驼峰字段（与 compute-pool/audit.ts 直传对齐），ts 是 ISO 字符串。
export interface HostAuditRow {
  /** BIGSERIAL 主键,后端保持 string(Number 超 2^53 丢精度,Codex R1 MINOR#2)。 */
  id: string;
  hostId: string | null;
  operation: string;
  operationId: string | null;
  reasonCode: string | null;
  detail: Record<string, unknown>;
  actor: string;
  ts: string;
}

export interface HostAuditResp {
  rows: HostAuditRow[];
  next_before: string | null;
}

// ─── 请求ID反查（GET /api/admin/trace/:traceId） ───────────────────
export interface TraceInfo {
  trace_id: string;
  user_id: string;
  username: string | null;
  session_key: string;
  agent_id: string | null;
  model: string | null;
  created_at: string;
}

export interface TraceLookupResp {
  trace: TraceInfo;
}
