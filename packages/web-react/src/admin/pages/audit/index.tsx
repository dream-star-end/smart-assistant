import { useState } from "react";
import { type TabItem, Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";
import { AdminAuditTab } from "./AdminAuditTab";
import { AgentAuditTab } from "./AgentAuditTab";
import { HostAuditTab } from "./HostAuditTab";
import { SecurityEventsTab } from "./SecurityEventsTab";
import { TraceLookup } from "./TraceLookup";
import { ProductFrictionTab } from "./ProductFrictionTab";

type AuditView = "admin" | "security" | "agent" | "friction" | "host";
const TABS: TabItem[] = [
  { value: "admin", label: "管理审计" },
  { value: "security", label: "安全事件" },
  { value: "agent", label: "Agent 工具失败" },
  { value: "friction", label: "产品摩擦" },
  { value: "host", label: "主机审计" },
];

/**
 * 审计日志页 —— 语义分层的四个只读子区，各自持有筛选/数据状态，切 tab 按需挂载
 * 对应子区（懒拉数据），不做破坏性操作：
 *  - 管理审计：admin_audit 操作日志（操作者/对象/时间过滤 + before/after diff）；
 *  - 安全事件：security_events（route_bypass 等，语义三分层第二层）；
 *  - Agent 工具失败：agent_audit 失败遥测；
 *  - 主机审计：compute_host_audit 全量浏览。
 * 页头右侧常驻「请求ID反查」（turn_traces 一键定位归属）。
 */
export default function AuditPage() {
  const meta = getAdminPage("audit");
  const [tab, setTab] = useState<AuditView>("admin");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} actions={<TraceLookup />} />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as AuditView)}
        items={TABS}
        aria-label="审计日志分区"
      />
      {tab === "admin" && <AdminAuditTab />}
      {tab === "security" && <SecurityEventsTab />}
      {tab === "agent" && <AgentAuditTab />}
      {tab === "friction" && <ProductFrictionTab />}
      {tab === "host" && <HostAuditTab />}
    </div>
  );
}
