import {
  CreditCard,
  Info,
  RefreshCw,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Alert, Badge, Button, EmptyState, Skeleton } from "../../../components/ui";
import { PageHeader, SectionCard } from "../../components";
import { apiErrorMessage } from "../../lib/adminApi";
import { getAdminPage } from "../../registry";
import { SettingRow } from "./SettingRow";
import { groupSettings } from "./grouping";
import { useSettings } from "./useSettings";

function groupIcon(id: string): { icon: LucideIcon; tone: "accent" | "warning" | "info" | "neutral" } {
  if (id === "risk") return { icon: ShieldAlert, tone: "warning" };
  if (id === "signup" || id === "onboarding") return { icon: UserPlus, tone: "info" };
  if (id === "billing") return { icon: CreditCard, tone: "accent" };
  return { icon: SlidersHorizontal, tone: "accent" };
}

/**
 * 系统设置：GET /api/admin/settings 拉全量，按 key 前缀重组为分区卡，逐项按 meta.kind 渲染 editor。
 * 每项独立「保存」→ PUT /api/admin/settings/:key，成功后整表重拉（等价 vanilla applyHash）。
 * 与 vanilla renderSettingsTab 功能等价，升级点仅为「一张大表 → 按前缀分区卡」的展示重组。
 */
export default function SettingsPage() {
  const meta = getAdminPage("settings");
  const { rows, loading, error, nonce, reload } = useSettings();
  const groups = useMemo(() => groupSettings(rows), [rows]);

  const firstLoad = loading && rows.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Settings}
        title={meta.title}
        desc={meta.desc}
        badge={
          rows.length > 0 ? (
            <Badge tone="neutral" className="tabular-nums">
              {rows.length} 项配置
            </Badge>
          ) : undefined
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={reload}
            disabled={loading}
            className="oc-btn-tactile gap-1.5"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
        }
      />

      {/* 语义说明：默认=继承平台默认值；改动一次即持久化并同事务写 admin_audit（对齐 vanilla 提示）。 */}
      <div className="oc-callout oc-callout-info flex items-start gap-2.5 rounded-xl px-4 py-3 text-meta leading-relaxed text-muted">
        <Info size={15} className="mt-0.5 shrink-0 text-info" />
        <div>
          标注
          <Badge tone="neutral" className="mx-1 align-middle">
            默认
          </Badge>
          的项当前继承平台默认值、尚未持久化；改动一次并保存后会写入 system_settings 表并标记
          <Badge tone="info" className="mx-1 align-middle">
            已覆盖
          </Badge>
          。所有改动同事务写 admin_audit。改完逐项「保存」立即生效。
        </div>
      </div>

      {error ? (
        <Alert tone="danger">加载失败：{apiErrorMessage(error, "请求失败")}</Alert>
      ) : firstLoad ? (
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="无系统设置项"
          hint="后端未返回任何可配置项。"
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => {
            const visual = groupIcon(g.id);
            return (
              <SectionCard
                key={g.id}
                title={g.title}
                hint={g.hint}
                icon={visual.icon}
                iconTone={visual.tone}
                action={
                  <Badge tone="neutral" className="tabular-nums">
                    {g.rows.length} 项
                  </Badge>
                }
              >
                <div className="divide-y divide-border/80">
                  {g.rows.map((r) => (
                    // nonce 入 key：保存后整表重拉即把每行 draft 重置到服务端权威值。
                    <SettingRow key={`${nonce}:${r.key}`} row={r} onSaved={reload} />
                  ))}
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
