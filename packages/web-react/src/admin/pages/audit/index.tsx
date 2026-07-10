import { useState } from "react";
import { type TabItem, Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";
import { AdminAuditTab } from "./AdminAuditTab";
import { AgentAuditTab } from "./AgentAuditTab";

type AuditView = "admin" | "agent";
const TABS: TabItem[] = [
  { value: "admin", label: "管理审计" },
  { value: "agent", label: "Agent 工具审计" },
];

/**
 * 审计日志页 —— 两个只读子区(管理审计 / Agent 工具审计),各自持有筛选/数据状态。
 * 切 tab 时按需挂载对应子区(懒拉数据),不做破坏性操作。
 */
export default function AuditPage() {
  const meta = getAdminPage("audit");
  const [tab, setTab] = useState<AuditView>("admin");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as AuditView)}
        items={TABS}
        aria-label="审计日志分区"
      />
      {tab === "admin" ? <AdminAuditTab /> : <AgentAuditTab />}
    </div>
  );
}
