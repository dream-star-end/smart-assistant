import { useState } from "react";
import { FeaturedPanel } from "../../../components/marketplace/FeaturedPanel";
import { ReviewPanel } from "../../../components/marketplace/ReviewPanel";
import { Tabs } from "../../../components/ui";
import { PageHeader } from "../../components";
import { adminSession } from "../../auth";
import { getAdminPage } from "../../registry";

const TAB_ITEMS = [
  { value: "review", label: "审核" },
  { value: "featured", label: "精选管理" },
];

/**
 * 用户触达 · 技能市场管理页 —— 两区：审核 + 精选管理。
 *
 * 复用用户端市场中心的两个共享组件（唯一权威实现，admin 不重写精简版）：
 *  - 「审核」<ReviewPanel>：待审队列（批准/拒绝须附理由）+ 批量 + AI 审批记录 + 下架 kill-switch；
 *  - 「精选管理」<FeaturedPanel>：目录里设/取消平台精选（featured_rank），数据源=既有市场搜索。
 *
 * 干净复用的关键：两组件都只依赖一个 `auth: AuthSession`，而管理后台的 `adminSession`
 * 本身就是 AuthSession（access token 唯一权威源 + 401 透明刷新）。把 adminSession 传进去，
 * 组件内的 api.admin… / api.searchMarketplace 调用即带 admin token 命中同一批端点。
 */
export default function MarketplacePage() {
  const meta = getAdminPage("marketplace");
  const [tab, setTab] = useState("review");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <Tabs value={tab} onValueChange={setTab} items={TAB_ITEMS} aria-label="技能市场分区" />
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {tab === "review" && <ReviewPanel auth={adminSession} />}
        {tab === "featured" && <FeaturedPanel auth={adminSession} />}
      </div>
    </div>
  );
}
