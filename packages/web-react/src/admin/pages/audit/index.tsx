import {
  Activity,
  History,
  ScrollText,
  Server,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import { type TabItem, Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";
import { AdminAuditTab } from "./AdminAuditTab";
import { AgentAuditTab } from "./AgentAuditTab";
import { HostAuditTab } from "./HostAuditTab";
import { ProductFrictionTab } from "./ProductFrictionTab";
import { SecurityEventsTab } from "./SecurityEventsTab";
import { TraceLookup } from "./TraceLookup";

type AuditView = "admin" | "security" | "agent" | "friction" | "host";

const TABS: TabItem[] = [
  {
    value: "admin",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <ScrollText size={13.5} aria-hidden="true" className="shrink-0 opacity-75" />
        管理审计
      </span>
    ),
  },
  {
    value: "security",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <ShieldAlert size={13.5} aria-hidden="true" className="shrink-0 opacity-75" />
        安全事件
      </span>
    ),
  },
  {
    value: "agent",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Terminal size={13.5} aria-hidden="true" className="shrink-0 opacity-75" />
        Agent 工具失败
      </span>
    ),
  },
  {
    value: "friction",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Activity size={13.5} aria-hidden="true" className="shrink-0 opacity-75" />
        产品摩擦
      </span>
    ),
  },
  {
    value: "host",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Server size={13.5} aria-hidden="true" className="shrink-0 opacity-75" />
        主机审计
      </span>
    ),
  },
];

/**
 * 审计日志页 —— 语义分层的五个只读子区，各自持有筛选/数据状态，切 tab 按需挂载
 * 对应子区（懒拉数据），不做破坏性操作：
 *  - 管理审计：admin_audit 操作日志（操作者/对象/时间过滤 + before/after diff）；
 *  - 安全事件：security_events（route_bypass 等，语义三分层第二层）；
 *  - Agent 工具失败：agent_audit 失败遥测；
 *  - 产品摩擦：product-friction 用户可见失败、恢复与问题卡漏斗；
 *  - 主机审计：compute_host_audit 全量浏览。
 * 页头右侧常驻「请求ID反查」（turn_traces 一键定位归属）。
 */
export default function AuditPage() {
  const meta = getAdminPage("audit");
  const [tab, setTab] = useState<AuditView>("admin");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        icon={History}
        actions={<TraceLookup />}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as AuditView)}
          items={TABS}
          idBase="audit"
          aria-label="审计日志分区"
        />
      </div>
      <div
        id={`audit-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`audit-tab-${tab}`}
      >
        {tab === "admin" && <AdminAuditTab />}
        {tab === "security" && <SecurityEventsTab />}
        {tab === "agent" && <AgentAuditTab />}
        {tab === "friction" && <ProductFrictionTab embedded />}
        {tab === "host" && <HostAuditTab />}
      </div>
    </div>
  );
}
