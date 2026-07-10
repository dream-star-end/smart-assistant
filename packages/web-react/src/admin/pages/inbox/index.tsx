import { useState } from "react";
import { PageHeader } from "../../components";
import { getAdminPage } from "../../registry";
import { ComposeCard } from "./ComposeCard";
import { HistoryTable } from "./HistoryTable";

/**
 * 用户触达 · 站内信页。发送卡（全员/单人 + 级别 + Markdown 正文 + 可选过期 + 邮件同发）
 * + 历史消息表（受众/级别/触达/删除）。平移旧 vanilla renderInboxTab（admin.js:6237）。
 * 发送成功后 bump reloadKey 触发历史表重拉。
 */
export default function InboxPage() {
  const meta = getAdminPage("inbox");
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <ComposeCard onSent={() => setReloadKey((n) => n + 1)} />
      <HistoryTable reloadKey={reloadKey} />
    </div>
  );
}
