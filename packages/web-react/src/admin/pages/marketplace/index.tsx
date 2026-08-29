import { Clock3, Eye, PackageCheck, Repeat2, ScanSearch, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { FeaturedPanel } from "../../../components/marketplace/FeaturedPanel";
import { ReviewPanel } from "../../../components/marketplace/ReviewPanel";
import { Alert, Badge, Tabs } from "../../../components/ui";
import { type Column, DataTable, PageHeader, SelectFilter, StatCard, StatCardRow } from "../../components";
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
  cohort: {
    availability: "available" | "partial";
    unavailable_events: number;
    exposure_pairs: number;
    detail_pairs: number;
    installed_pairs: number;
    first_use_pairs: number;
    repeat_pairs: number;
    conversions: {
      exposure_to_detail: number | null;
      detail_to_install: number | null;
      install_to_first_use: number | null;
      first_use_to_repeat: number | null;
    };
  };
  hub_only?: { exposure_users: number; exposure_events: number } | null;
  skill_level?: SkillFunnelRow[];
  time_to_first_use?: { sample_size: number; median_seconds: number | null; p95_seconds: number | null } | null;
  install_failures?: Array<{ reason: string; count: number }>;
};

type SkillFunnelRow = {
  skill_slug: string;
  exposure_pairs: number;
  installed_pairs: number;
  first_use_pairs: number;
  repeat_pairs: number;
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

function conversion(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "不可用";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

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
  const cohort = data?.cohort;
  const cohortAvailable = cohort?.availability === "available";
  const skillColumns: Column<SkillFunnelRow>[] = [
    { key: "skill_slug", title: "技能", render: (row) => <span className="font-mono text-[12px]">{row.skill_slug}</span> },
    { key: "exposure_pairs", title: "曝光对", align: "right" },
    { key: "installed_pairs", title: "安装对", align: "right" },
    { key: "first_use_pairs", title: "首用对", align: "right" },
    { key: "repeat_pairs", title: "复用对", align: "right" },
  ];
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
      {data && !cohortAvailable && (
        <Alert tone="warning" title="历史数据不可计算漏斗">
          {cohort?.unavailable_events ?? 0} 条历史阶段事件缺少同一 user + skill 的前向旅程依据。以下只展示各阶段观测量，不计算或暗示转化率。
        </Alert>
      )}
      {cohortAvailable ? (
        <>
          <Alert tone="success" title="同一 user + skill 前向 cohort">
            仅当同一用户、同一技能按曝光→详情→安装→首用→复用前向发生时计入转化。
          </Alert>
          <StatCardRow>
            <StatCard label="曝光→详情" value={conversion(cohort.conversions.exposure_to_detail)} hint={`${cohort.exposure_pairs} → ${cohort.detail_pairs} 对`} icon={Eye} tone="info" />
            <StatCard label="详情→安装" value={conversion(cohort.conversions.detail_to_install)} hint={`${cohort.detail_pairs} → ${cohort.installed_pairs} 对`} icon={PackageCheck} tone="info" />
            <StatCard label="安装→首用" value={conversion(cohort.conversions.install_to_first_use)} hint={`${cohort.installed_pairs} → ${cohort.first_use_pairs} 对`} icon={Users} tone="success" />
            <StatCard label="首用→复用" value={conversion(cohort.conversions.first_use_to_repeat)} hint={`${cohort.first_use_pairs} → ${cohort.repeat_pairs} 对`} icon={Repeat2} tone="accent" />
          </StatCardRow>
        </>
      ) : (
        <StatCardRow>
          <StatCard label="目录曝光（独立观测）" value={f?.exposure_users ?? "…"} hint={`${f?.exposure_events ?? 0} 次展示 · 不计算转化`} icon={Eye} tone="neutral" />
          <StatCard label="详情（独立观测）" value={f?.detail_users ?? "…"} hint={`${f?.detail_events ?? 0} 次打开 · 不计算转化`} icon={ScanSearch} tone="neutral" />
          <StatCard label="安装（独立观测）" value={f?.install_users ?? "…"} hint={`${f?.installs ?? 0} 次安装 · 不计算转化`} icon={PackageCheck} tone="neutral" />
          <StatCard label="首用（独立观测）" value={f?.first_use_users ?? "…"} hint="不与安装阶段作转化比较" icon={Users} tone="neutral" />
        </StatCardRow>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-elevated p-4">
          <h3 className="text-sm font-semibold text-fg">市场中心曝光（hub-only）</h3>
          {data?.hub_only ? (
            <p className="mt-3 text-sm text-muted">{data.hub_only.exposure_users} 位用户 · {data.hub_only.exposure_events} 次目录展示</p>
          ) : (
            <p className="mt-3 text-sm text-faint">当前 API 未提供 hub-only 口径，暂不推算。</p>
          )}
        </div>
        <div className="rounded-xl border border-border bg-elevated p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg"><Clock3 size={15} />安装到首次成功使用</h3>
          {data?.time_to_first_use ? (
            <p className="mt-3 text-sm text-muted">中位数 {duration(data.time_to_first_use.median_seconds)} · p95 {duration(data.time_to_first_use.p95_seconds)} · n={data.time_to_first_use.sample_size}</p>
          ) : (
            <p className="mt-3 text-sm text-faint">当前 API 未提供可关联样本，暂不可用。</p>
          )}
        </div>
      </div>
      <DataTable
        columns={skillColumns}
        rows={data?.skill_level ?? []}
        rowKey={(row) => row.skill_slug}
        emptyTitle="暂无技能级 journey"
        emptyHint="接口未返回 skill-level 数据时不从独立阶段数推算。"
      />
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
      <div className="rounded-xl border border-border bg-elevated p-4">
        <h3 className="text-sm font-semibold text-fg">安装失败原因</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {(data?.install_failures ?? []).length === 0 ? (
            <span className="text-sm text-faint">无数据；不将卸载原因替代为安装失败原因。</span>
          ) : data?.install_failures?.map((row) => (
            <Badge key={row.reason} tone="warning">{REASON_LABEL[row.reason] ?? row.reason} · {row.count}</Badge>
          ))}
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
