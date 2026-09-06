import { useEffect, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type {
  ApiKeySummary,
  ApiKeyUsageReport,
  AuthSession,
  UsageReportWindow,
} from "../../lib/types";
import { cn, formatCompactCount, formatCredits, groupDigits } from "../../lib/utils";
import { ChartCard, chartNum, lineConfig, useChart } from "../charts";
import { Alert, Button, Select, Skeleton, Tabs } from "../ui";
import { ApiKeysSection } from "./ApiKeysSection";
import { formatReportBucket, REPORT_WINDOW_NOUN, shortTime } from "./labels";

const WINDOWS: { value: UsageReportWindow; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const ALL_KEYS = "";

/**
 * 设置 → API 接入(admin-only,由 SettingsCenter 按角色控制挂载)。
 *
 * 上半:API Key 自管(创建 / 重命名 / 禁用 / 上限 / 撤销 + 本地 Claude Code 接入片段)。
 * 下半:API Key 流量消耗统计(GET /api/me/api-keys/usage),与容器/网页聊天用量分离 ——
 * 只统计 usage_records.api_key_id 非空的记录。窗口 24h/7d/30d + 单 key 过滤。
 * 大数全程字符串(formatCredits / formatCompactCount / groupDigits),仅图表 dataset 经 chartNum。
 */
export function ApiAccessTab({ auth }: { auth: AuthSession }) {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-4">
        <div className="text-section font-medium text-fg">API 接入</div>
        <p className="mt-1 text-caption text-muted">
          用 API Key 把本地 Claude Code 等工具接到本站的 Cursor 系模型。此处的消耗统计只含 API Key
          流量,不含网页对话。
        </p>
      </div>

      <ApiKeysSection auth={auth} onKeysChange={setKeys} />

      <ApiKeyUsagePanel auth={auth} keys={keys} />
    </div>
  );
}

/** 消耗统计面板。导出供单测直接挂载(免走 ApiKeysSection 的列表请求)。 */
export function ApiKeyUsagePanel({ auth, keys }: { auth: AuthSession; keys: ApiKeySummary[] }) {
  const [window, setWindow] = useState<UsageReportWindow>("7d");
  const [keyId, setKeyId] = useState<string>(ALL_KEYS);
  const [report, setReport] = useState<ApiKeyUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // 被撤销的 key 会从列表消失;若当前正按它过滤则回到「全部」。
  useEffect(() => {
    if (keyId !== ALL_KEYS && !keys.some((k) => k.id === keyId)) setKeyId(ALL_KEYS);
  }, [keys, keyId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 是显式重试触发器。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setReport(null);
    api
      .getApiKeyUsage(auth, window, keyId === ALL_KEYS ? undefined : keyId)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载 API Key 消耗统计失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, window, keyId, reloadTick]);

  const rs = report?.summary ?? null;
  const trendLabels = report ? report.trend.map((p) => formatReportBucket(p.bucket, window)) : [];
  const creditTrend = report ? report.trend.map((p) => chartNum(p.credits)) : [];
  const chartReady = !loading && report !== null;
  const creditRef = useRef<HTMLCanvasElement>(null);

  useChart(
    creditRef,
    (theme) =>
      lineConfig(theme, {
        labels: trendLabels,
        series: [{ label: "积分消耗", data: creditTrend, colorToken: "accent", fill: true }],
      }),
    [report, window, chartReady],
  );

  const keyOptions = [
    { value: ALL_KEYS, label: "全部密钥" },
    ...keys.map((k) => ({
      value: k.id,
      label: k.disabledAt ? `${k.label}(已禁用)` : k.label,
    })),
  ];

  return (
    <div className="border-t border-border px-5 py-4" data-api-key-usage>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="text-caption font-medium uppercase tracking-wide text-faint">
          消耗统计 · 近 {REPORT_WINDOW_NOUN[window]}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tabs
            aria-label="统计窗口"
            value={window}
            onValueChange={(v) => setWindow(v as UsageReportWindow)}
            items={WINDOWS}
          />
          <Select
            aria-label="按密钥过滤"
            value={keyId}
            onValueChange={setKeyId}
            options={keyOptions}
            inputSize="sm"
            className="w-40"
          />
        </div>
      </div>

      {loading ? (
        <div>
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[58px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="mt-3 h-[220px] rounded-xl" />
        </div>
      ) : err ? (
        <div>
          <Alert tone="danger" className="text-meta">
            {err}
          </Alert>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setReloadTick((t) => t + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        report &&
        rs && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="请求数" value={groupDigits(rs.requests)} />
              <Stat label="消耗积分" value={`${formatCredits(rs.credits)} 积分`} accent />
              <Stat label="输入 token" value={formatCompactCount(rs.input_tokens)} />
              <Stat label="输出 token" value={formatCompactCount(rs.output_tokens)} />
            </div>

            <div className="mt-3">
              <ChartCard
                title="积分消耗趋势"
                height={200}
                ariaLabel={`API Key 积分消耗趋势,近 ${REPORT_WINDOW_NOUN[window]}`}
                dataTable={{
                  columns: ["时间", "消耗积分"],
                  rows: report.trend.map((point, index) => [
                    trendLabels[index],
                    `${formatCredits(point.credits)} 积分`,
                  ]),
                  emptyText: "该时段暂无积分消耗数据。",
                }}
              >
                <canvas ref={creditRef} />
              </ChartCard>
            </div>

            <SubHeading>按密钥</SubHeading>
            {report.by_key.length === 0 ? (
              <EmptyRow>该时段暂无 API Key 用量。</EmptyRow>
            ) : (
              <TableShell caption={`按密钥用量,近 ${REPORT_WINDOW_NOUN[window]}`} minWidth="32rem">
                <thead className="bg-hover text-caption font-medium uppercase tracking-wide text-faint">
                  <tr>
                    <th className="px-3 py-2">名称</th>
                    <th className="px-3 py-2">前缀</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2 text-right">请求</th>
                    <th className="px-3 py-2 text-right">输入</th>
                    <th className="px-3 py-2 text-right">输出</th>
                    <th className="px-3 py-2 text-right">积分</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_key.map((row) => (
                    <tr key={row.api_key_id} className="border-t border-border">
                      <td className="max-w-[12rem] truncate px-3 py-2 text-fg">
                        {row.label ?? "(未知)"}
                      </td>
                      <td className="px-3 py-2 font-mono text-faint">
                        {row.key_prefix ? `${row.key_prefix}···` : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <KeyStatus revoked={row.revoked} disabled={row.disabled} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {groupDigits(row.requests)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(row.input_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(row.output_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCredits(row.credits)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}

            <SubHeading>按模型</SubHeading>
            {report.by_model.length === 0 ? (
              <EmptyRow>该时段暂无模型用量。</EmptyRow>
            ) : (
              <TableShell caption={`按模型用量,近 ${REPORT_WINDOW_NOUN[window]}`} minWidth="36rem">
                <thead className="bg-hover text-caption font-medium uppercase tracking-wide text-faint">
                  <tr>
                    <th className="px-3 py-2">模型</th>
                    <th className="px-3 py-2 text-right">请求</th>
                    <th className="px-3 py-2 text-right">输入</th>
                    <th className="px-3 py-2 text-right">输出</th>
                    <th className="px-3 py-2 text-right">缓存命中</th>
                    <th className="px-3 py-2 text-right">缓存写入</th>
                    <th className="px-3 py-2 text-right">积分</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_model.map((model) => (
                    <tr key={model.model} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-fg">{model.model}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {groupDigits(model.requests)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(model.input_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(model.output_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(model.cache_read_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(model.cache_write_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCredits(model.credits)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}

            <SubHeading>最近请求</SubHeading>
            {report.recent.length === 0 ? (
              <EmptyRow>该时段暂无请求记录。</EmptyRow>
            ) : (
              <TableShell
                caption={`最近 API Key 请求,近 ${REPORT_WINDOW_NOUN[window]}`}
                minWidth="36rem"
              >
                <thead className="bg-hover text-caption font-medium uppercase tracking-wide text-faint">
                  <tr>
                    <th className="px-3 py-2">时间</th>
                    <th className="px-3 py-2">密钥</th>
                    <th className="px-3 py-2">模型</th>
                    <th className="px-3 py-2 text-right">输入</th>
                    <th className="px-3 py-2 text-right">输出</th>
                    <th className="px-3 py-2 text-right">积分</th>
                    <th className="px-3 py-2">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
                        {shortTime(row.created_at)}
                      </td>
                      <td className="max-w-[10rem] truncate px-3 py-2 text-fg">
                        {row.label ?? "(已撤销)"}
                      </td>
                      <td className="px-3 py-2 font-mono text-fg">{row.model}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(row.input_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCompactCount(row.output_tokens)}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCredits(row.cost_credits)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-caption",
                            row.status === "success"
                              ? "bg-success-soft text-success"
                              : "bg-danger-soft text-danger",
                          )}
                        >
                          {row.status === "success" ? "成功" : row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </>
        )
      )}
    </div>
  );
}

function KeyStatus({ revoked, disabled }: { revoked: boolean; disabled: boolean }) {
  if (revoked) {
    return <span className="rounded bg-hover px-1.5 py-0.5 text-caption text-faint">已撤销</span>;
  }
  if (disabled) {
    return (
      <span className="rounded bg-warning-soft px-1.5 py-0.5 text-caption text-warning">
        已禁用
      </span>
    );
  }
  return (
    <span className="rounded bg-success-soft px-1.5 py-0.5 text-caption text-success">启用中</span>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 pb-2 text-caption font-medium uppercase tracking-wide text-faint">
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-meta text-faint">{children}</p>;
}

function TableShell({
  caption,
  minWidth,
  children,
}: {
  caption: string;
  minWidth: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-meta" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="text-caption text-faint">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-[16px] font-semibold tabular-nums",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
