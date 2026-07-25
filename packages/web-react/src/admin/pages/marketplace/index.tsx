import { Eye, PackageCheck, Repeat2, ScanSearch, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { FeaturedPanel } from "../../../components/marketplace/FeaturedPanel";
import { ReviewPanel } from "../../../components/marketplace/ReviewPanel";
import { Alert, Badge, Tabs } from "../../../components/ui";
import { PageHeader, SelectFilter, StatCard, StatCardRow } from "../../components";
import { adminSession } from "../../auth";
import { adminGet, apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";

const TAB_ITEMS = [
  { value: "review", label: "审核" },
  { value: "featured", label: "精选管理" },
  { value: "funnel", label: "使用漏斗" },
];

type FunnelResponse = {
  traffic_class: string;
  funnel: {
    exposure_users: number;
    exposure_events: number;
    detail_users: number;
    detail_events: number;
    install_users: number;
    installs: number;
    first_use_users: number;
    used_pairs: number;
    repeat_pairs: number;
  };
  uninstall_reasons: Array<{ reason: string; count: number }>;
};

const TRAFFIC_OPTIONS = [
  { label: "真实用户", value: "production_user" },
  { label: "全部流量", value: "all" },
  { label: "内部管理员", value: "internal_admin" },
  { label: "合成灰度", value: "synthetic_canary" },
  { label: "E2E", value: "e2e" },
];
const REASON_LABEL: Record<string, string> = {
  not_needed: "暂时不需要",
  poor_quality: "效果不好",
  missing_capability: "缺少能力",
  install_error: "安装/使用问题",
  other: "其他",
  prefer_not_say: "未说明",
};

function FunnelPanel() {
  const [traffic, setTraffic] = useState("production_user");
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    adminGet<FunnelResponse>("/marketplace/funnel", { traffic_class: traffic })
      .then((result) => {
        if (alive) setData(result);
      })
      .catch((cause) => {
        if (alive) setError(apiErrorMessage(cause, "加载市场漏斗失败"));
      });
    return () => {
      alive = false;
    };
  }, [traffic]);
  const f = data?.funnel;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">近 30 天；默认只统计真实用户。</p>
        <SelectFilter
          label="流量"
          value={traffic}
          options={TRAFFIC_OPTIONS}
          onChange={setTraffic}
        />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <StatCardRow>
        <StatCard
          label="目录曝光用户"
          value={f?.exposure_users ?? "…"}
          hint={`${f?.exposure_events ?? 0} 次真实展示`}
          icon={Eye}
          tone="info"
        />
        <StatCard
          label="详情用户"
          value={f?.detail_users ?? "…"}
          hint={`${f?.detail_events ?? 0} 次打开`}
          icon={ScanSearch}
          tone="info"
        />
        <StatCard
          label="安装用户"
          value={f?.install_users ?? "…"}
          hint={`${f?.installs ?? 0} 次安装`}
          icon={PackageCheck}
          tone="success"
        />
        <StatCard
          label="首用用户"
          value={f?.first_use_users ?? "…"}
          hint={`${f?.used_pairs ?? 0} 个用户/技能对`}
          icon={Users}
          tone="success"
        />
        <StatCard
          label="复用"
          value={f?.repeat_pairs ?? "…"}
          hint="使用至少 2 次的用户/技能对"
          icon={Repeat2}
          tone="accent"
        />
      </StatCardRow>
      <div className="rounded-xl border border-border bg-elevated p-4">
        <h3 className="text-sm font-semibold text-fg">卸载原因</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {(data?.uninstall_reasons ?? []).length === 0 ? (
            <span className="text-sm text-faint">近 30 天暂无卸载</span>
          ) : (
            data?.uninstall_reasons.map((row) => (
              <Badge key={row.reason} tone="neutral">
                {REASON_LABEL[row.reason] ?? row.reason} · {row.count}
              </Badge>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

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
        {tab === "funnel" && <FunnelPanel />}
      </div>
    </div>
  );
}
