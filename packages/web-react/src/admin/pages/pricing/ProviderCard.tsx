import type { ChartConfiguration } from "chart.js";
import { useRef, useState } from "react";
import { Badge, Button, Card, Input, useToast } from "../../../components/ui";
import { TimeAgo, useChart } from "../../components";
import { isoToDateInput, providerUsageLine, subCountdown, utilTone } from "./helpers";
import type { HealthMode, ProviderData } from "./types";

const HEALTH_MODE_LABELS: Record<HealthMode, string> = {
  auto: "自动",
  forced_degraded: "强制降级",
  forced_healthy: "强制健康",
};

function LatencySparkline({ provider }: { provider: ProviderData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const samples = provider.samples ?? [];
  useChart(
    ref,
    (theme) => {
      const accent = theme.color("accent");
      const danger = theme.color("danger");
      return {
        type: "line",
        data: {
          labels: samples.map((s) => `${s.probed_at}${s.ok ? "" : " · fail"}`),
          datasets: [
            {
              data: samples.map((s) => (typeof s.latency_ms === "number" ? s.latency_ms : null)),
              borderColor: accent,
              borderWidth: 1.5,
              backgroundColor: "transparent",
              pointRadius: samples.map((s) => (s.ok ? 0 : 2.5)),
              pointHoverRadius: 3,
              pointBackgroundColor: samples.map((s) => (s.ok ? accent : danger)),
              pointBorderColor: samples.map((s) => (s.ok ? accent : danger)),
              tension: 0.3,
              spanGaps: true,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                // biome-ignore lint/suspicious/noExplicitAny: chart.js ctx 动态类型
                label: (ctx: any) => (ctx.parsed.y == null ? "失败" : `${ctx.parsed.y} ms`),
              },
            },
          },
          scales: { x: { display: false }, y: { display: false } },
        },
      } as ChartConfiguration;
    },
    [samples],
  );
  return (
    <div className="relative h-10 w-full">
      <canvas ref={ref} />
    </div>
  );
}

function HealthBadge({ provider }: { provider: ProviderData }) {
  const h = provider.health;
  const degraded = h.effective === "degraded";
  const modeTag =
    h.mode === "forced_degraded" ? " · 强制降级" : h.mode === "forced_healthy" ? " · 强制健康" : "";
  const notes: string[] = [];
  if (degraded && h.reason) notes.push(h.reason);
  if (
    (h.mode === "forced_healthy" && h.observed === "degraded") ||
    (h.mode === "forced_degraded" && h.observed === "healthy")
  ) {
    notes.push(`实测${h.observed === "degraded" ? "降级" : "健康"}`);
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={degraded ? "danger" : "success"} title={notes.join(" · ") || undefined}>
        {degraded ? "降级" : "健康"}
        {modeTag}
      </Badge>
      {notes.length > 0 && <span className="text-[11px] text-faint">{notes.join(" · ")}</span>}
    </span>
  );
}

/**
 * 服务商运维卡:key 状态 / 延迟(latest + sparkline)/ 健康三态 / 并发利用率 /
 * 24h 用量 / 订阅到期倒计时 + 可编辑并发上限、订阅日、备注。
 * draft 全程 live;30s 轮询只改 inflightCurrent prop,不 remount 本卡 → draft 不丢。
 */
export function ProviderCard({
  provider,
  inflightCurrent,
  onSave,
  onSetHealthMode,
}: {
  provider: ProviderData;
  inflightCurrent: number;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onSetHealthMode: (mode: HealthMode) => Promise<void>;
}) {
  const toast = useToast();
  const [climit, setClimit] = useState(
    provider.concurrency_limit == null ? "" : String(provider.concurrency_limit),
  );
  const [subDate, setSubDate] = useState(isoToDateInput(provider.subscription_expires_at));
  const [notes, setNotes] = useState(provider.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState<HealthMode | null>(null);

  const countdown = subCountdown(provider.subscription_expires_at);
  const limit = provider.concurrency_limit;
  const hasLimit = limit != null && Number(limit) > 0;
  const util = hasLimit ? utilTone(inflightCurrent, Number(limit)) : null;

  const save = async () => {
    const climitRaw = climit.trim();
    let concurrency_limit: number | null = null;
    if (climitRaw !== "") {
      if (!/^\d{1,9}$/.test(climitRaw) || Number(climitRaw) < 1) {
        toast("并发上限必须是正整数(留空=不限)", "error");
        return;
      }
      concurrency_limit = Number(climitRaw);
    }
    // 订阅到期:日期未改 → 原 ISO 原样回传(PUT 全量语义,防本地化漂移);
    // 改了 → 本地当天 23:59:59(到期语义=当天仍可用);清空 → null。
    let subscription_expires_at: string | null;
    if (subDate === isoToDateInput(provider.subscription_expires_at)) {
      subscription_expires_at = provider.subscription_expires_at ?? null;
    } else if (subDate === "") {
      subscription_expires_at = null;
    } else {
      const d = new Date(`${subDate}T23:59:59`);
      if (Number.isNaN(d.getTime())) {
        toast("订阅到期日期无效", "error");
        return;
      }
      subscription_expires_at = d.toISOString();
    }
    const notesTrim = notes.trim();
    setSaving(true);
    try {
      await onSave({
        subscription_expires_at,
        notes: notesTrim === "" ? null : notesTrim,
        // display_name 本页不编辑:透传原值,防 PUT 全量替换把它清掉。
        display_name: provider.display_name ?? null,
        concurrency_limit,
      });
    } finally {
      setSaving(false);
    }
  };

  const switchMode = async (mode: HealthMode) => {
    setSwitching(mode);
    try {
      await onSetHealthMode(mode);
    } finally {
      setSwitching(null);
    }
  };

  const row = "flex items-center gap-2 text-[12.5px]";
  const rowLabel = "w-16 shrink-0 text-faint";

  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-fg">
            {provider.display_name || provider.id}
          </h3>
          <span className="font-mono text-[11px] text-faint">{provider.id}</span>
        </div>
        {provider.keyConfigured ? (
          <Badge tone="success">已配置</Badge>
        ) : (
          <Badge tone="danger">缺 key</Badge>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        <span className="truncate font-mono">{provider.endpoint || "—"}</span>
        <Badge tone={provider.egress === "proxy" ? "success" : "neutral"}>
          {provider.egress || "direct"}
        </Badge>
      </div>

      <div className={row}>
        <span className={rowLabel}>延迟</span>
        {provider.probeEnabled === false ? (
          <Badge tone="neutral">不探测(经账号代理)</Badge>
        ) : provider.latest ? (
          <span className="inline-flex items-center gap-1.5">
            <Badge
              tone={provider.latest.ok ? "success" : "danger"}
              title={
                provider.latest.ok
                  ? undefined
                  : provider.latest.error || `HTTP ${provider.latest.status_code ?? "?"}`
              }
            >
              {provider.latest.latency_ms ?? "—"}ms
            </Badge>
            <TimeAgo value={provider.latest.probed_at} className="text-[11px] text-faint" />
          </span>
        ) : (
          <Badge tone="neutral">未探测</Badge>
        )}
      </div>

      <div className={row}>
        <span className={rowLabel}>健康</span>
        <HealthBadge provider={provider} />
      </div>

      <div className="flex items-center gap-1.5">
        <span className={rowLabel}>降级策略</span>
        <div className="flex flex-wrap gap-1">
          {(["auto", "forced_degraded", "forced_healthy"] as HealthMode[]).map((m) => {
            const active = provider.health.mode === m;
            return (
              <Button
                key={m}
                variant={active ? "subtle" : "secondary"}
                size="sm"
                disabled={active || switching !== null}
                onClick={() => switchMode(m)}
              >
                {active ? "✓ " : ""}
                {HEALTH_MODE_LABELS[m]}
              </Button>
            );
          })}
        </div>
      </div>

      {provider.probeEnabled !== false &&
        (provider.samples?.length ? (
          <LatencySparkline provider={provider} />
        ) : (
          <div className="flex h-10 items-center text-[11px] text-faint">暂无探测样本</div>
        ))}

      <div className="flex flex-col gap-1">
        <div className={row}>
          <span className={rowLabel}>并发</span>
          {hasLimit && util ? (
            <span className="flex-1">
              当前并发 <b className="tabular-nums">{inflightCurrent}</b> / 上限 {String(limit)}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover" title={`利用率 ${util.pct}%`}>
                <div
                  className={`h-full rounded-full ${util.tone === "danger" ? "bg-danger" : util.tone === "warning" ? "bg-warning" : "bg-success"}`}
                  style={{ width: `${util.pct}%` }}
                />
              </div>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              当前并发 <b className="tabular-nums">{inflightCurrent}</b>
              <Badge tone="neutral">无上限</Badge>
            </span>
          )}
        </div>
      </div>

      <div className={row}>
        <span className={rowLabel}>并发上限</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={climit}
          onChange={(e) => setClimit(e.target.value)}
          placeholder="空=不限"
          className="h-8 w-28 text-[13px] tabular-nums"
        />
      </div>

      <div className="text-[11.5px] text-faint">{providerUsageLine(provider.usage_d1)}</div>

      <div className={row}>
        <span className={rowLabel}>订阅到期</span>
        <Input
          type="date"
          value={subDate}
          onChange={(e) => setSubDate(e.target.value)}
          className="h-8 w-40 text-[13px]"
        />
        <Badge
          tone={
            countdown.tone as "neutral" | "success" | "warning" | "danger" | "info" | "accent"
          }
        >
          {countdown.label}
        </Badge>
      </div>

      <div className={row}>
        <span className={rowLabel}>备注</span>
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          placeholder="账号归属 / 续费渠道等"
          className="h-8 flex-1 text-[13px]"
        />
      </div>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </Card>
  );
}
