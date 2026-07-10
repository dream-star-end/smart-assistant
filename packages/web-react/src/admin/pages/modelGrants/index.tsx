import { Construction } from "lucide-react";
import { EmptyState } from "../../../components/ui";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";

/**
 * 占位 stub —— 由 modelGrants 页面 agent 整体替换为真实实现（保持 default export 与本文件同名/同签名）。
 * 建设时用 PageHeader + StatCardRow + ChartCard + DataTable + FilterBar（见 src/admin/components）。
 */
export default function ModelGrantsPage() {
  const meta = getAdminPage("modelGrants");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <EmptyState
        icon={Construction}
        title="页面建设中"
        hint="该管理页正在迁移到新框架，稍后由对应页面 agent 填充。"
      />
    </div>
  );
}
