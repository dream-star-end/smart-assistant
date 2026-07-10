import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { Alert, Badge, Button, EmptyState, Skeleton } from "../../../components/ui";
import { PageHeader, SectionCard } from "../../components";
import { getAdminPage } from "../../registry";
import { SettingRow } from "./SettingRow";
import { groupSettings } from "./grouping";
import { useSettings } from "./useSettings";

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
        title={meta.title}
        desc={meta.desc}
        actions={
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading} className="gap-1.5">
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            刷新
          </Button>
        }
      />

      {/* 语义说明：默认=继承平台默认值；改动一次即持久化并同事务写 admin_audit（对齐 vanilla 提示）。 */}
      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-[12px] leading-relaxed text-muted">
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

      {error ? (
        <Alert tone="danger">加载失败：{error.message}</Alert>
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
          {groups.map((g) => (
            <SectionCard
              key={g.id}
              title={g.title}
              hint={g.hint}
              action={<Badge tone="neutral">{g.rows.length} 项</Badge>}
            >
              <div className="divide-y divide-border">
                {g.rows.map((r) => (
                  // nonce 入 key：保存后整表重拉即把每行 draft 重置到服务端权威值。
                  <SettingRow key={`${nonce}:${r.key}`} row={r} onSaved={reload} />
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}
