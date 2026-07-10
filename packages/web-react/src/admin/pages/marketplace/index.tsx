import { ReviewPanel } from "../../../components/marketplace/ReviewPanel";
import { PageHeader } from "../../components";
import { adminSession } from "../../auth";
import { getAdminPage } from "../../registry";

/**
 * 用户触达 · 技能市场审核页。
 *
 * 直接复用用户端市场中心的 admin 审核组件 <ReviewPanel>（496 行，唯一权威实现）：
 * 待审队列（批准 / 拒绝须附理由 usePrompt）+ 批量审核 + AI 审批记录（verdict/理由）
 * + 下架 RevokeBox（slug datalist + 名称回显确认）。
 *
 * 干净复用的关键：ReviewPanel 只依赖一个 `auth: AuthSession`，而管理后台的 `adminSession`
 * 本身就是 AuthSession（access token 唯一权威源 + 401 透明刷新）。因此把 adminSession 传进去，
 * 组件内的 api.adminMarketplace* 调用即带 admin token 命中同一批 /api/admin/marketplace/* 端点，
 * 无需在 admin 目录内重写一套精简版，也不改动被复用组件。
 */
export default function MarketplacePage() {
  const meta = getAdminPage("marketplace");
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <ReviewPanel auth={adminSession} />
      </div>
    </div>
  );
}
