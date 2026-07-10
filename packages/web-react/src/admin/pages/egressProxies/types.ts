// egressProxies 页数据形状 —— 对齐后端 serializeEgressProxy
// (commercial/src/http/admin/egressProxies.ts)。明文 URL 永不出库,只有 url_masked。

export type EgressProxyRow = {
  id: string;
  label: string;
  status: "active" | "disabled";
  notes: string | null;
  url_masked: string;
  created_at: string;
  updated_at: string;
};

export const EGRESS_STATUSES = ["active", "disabled"] as const;
