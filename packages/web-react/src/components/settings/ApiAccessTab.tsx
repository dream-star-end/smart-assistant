import { publicCursorModelId } from "@openclaude/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  apiErrorMessage,
  bearerHeaders,
  callWithRefresh,
  jsonOrThrow,
} from "../../lib/api";
import type {
  ApiKeySummary,
  ApiKeyUsageByKey,
  ApiKeyUsageRecent,
  ApiKeyUsageReport,
  AuthSession,
  UsageReportModel,
  UsageReportWindow,
} from "../../lib/types";
import { cn, formatCompactCount, formatCredits, groupDigits } from "../../lib/utils";
import { ChartCard, chartNum, lineConfig, useChart } from "../charts";
import { Alert, Button, Select, Skeleton, Switch, Tabs } from "../ui";
import { ApiKeysSection } from "./ApiKeysSection";
import { formatReportBucket, REPORT_WINDOW_NOUN, shortTime } from "./labels";
import { TablePager, useTablePage } from "./TablePager";

const WINDOWS: { value: UsageReportWindow; label: string }[] = [
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const ALL_KEYS = "";

/**
 * `GET /api/me/api-keys/usage` 的 `recent` 段在服务端固定取前 50 条
 * (`API_KEY_USAGE_RECENT_LIMIT`),它就是最近明细的第一页;后续页走
 * `GET /api/me/api-keys/usage/recent?before=<最后一行 id>`。
 *
 * 第一页**不满** 50 条 ⇒ 服务端已把该窗口内所有行给完了,直接判"已到底",不再多打一次
 * 必然空的请求;满 50 条才可能还有下一页。
 */
const RECENT_FIRST_PAGE_SIZE = 50;
/** 「加载更多」每次追加的行数(服务端上限 200)。 */
const RECENT_PAGE_SIZE = 50;
/** 请求审计每页行数(服务端上限 200)。 */
const AUDIT_PAGE_SIZE = 20;

/** `GET /api/me/api-keys/usage/recent` 返回体(与 billing/apiKeyUsageReport.ts 的 ApiKeyUsageRecentPage 同形)。 */
type ApiKeyUsageRecentPage = {
  window: UsageReportWindow;
  key_id: string | null;
  entries: ApiKeyUsageRecent[];
  /** 下一页游标;null = 已到底。 */
  next_before: string | null;
};

/** `GET /api/me/api-keys/messages` 单行(与 billing/apiKeyMessageAudit.ts 的 ApiKeyMessageAuditEntry 同形)。 */
export type ApiKeyMessageAuditEntry = {
  id: string;
  created_at: string;
  request_id: string;
  api_key_id: string | null;
  requested_model: string;
  model: string;
  effort: string | null;
  effort_source: string | null;
  account_id: string | null;
  body_sha256: string;
  body_bytes: number;
  message_count: number;
  tool_count: number;
  stream: boolean;
  last_user_message: string | null;
  last_user_message_truncated: boolean;
  status: string;
  terminal_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  client_user_agent: string | null;
};

type ApiKeyMessageAuditPage = {
  entries: ApiKeyMessageAuditEntry[];
  next_before: string | null;
};

/**
 * 这两个端点没有走 `lib/api` 的 `api.*` 门面 —— 它们是本页独有的 admin 只读分页,
 * 复用统一的透明刷新 / 身份围栏 / JSON 解包三件套即可(与 MediaTaskCenter 同一先例),
 * 不必为一次性的查询在全局 api 对象上再挂两个方法。
 */
async function getJson<T>(auth: AuthSession, path: string): Promise<T> {
  return jsonOrThrow<T>(
    callWithRefresh(auth, (token) =>
      fetch(path, { credentials: "include", headers: bearerHeaders(token) }),
    ),
  );
}

/** 档位来源 → 中文(protocol 的 CursorEffortSource,含 0280 的 classifier)。 */
const EFFORT_SOURCE_LABEL: Record<string, string> = {
  pinned: "钉死",
  request: "按请求",
  clamped: "就近",
  default: "默认",
  classifier: "分类器",
};

/** 审计行的档位展示:`high · 按请求`;无档位家族(单档)显示「—」。 */
export function effortLabel(effort: string | null, source: string | null): string {
  if (!effort) return source ? (EFFORT_SOURCE_LABEL[source] ?? source) : "—";
  const s = source ? (EFFORT_SOURCE_LABEL[source] ?? source) : null;
  return s ? `${effort} · ${s}` : effort;
}

/** 毫秒 → 人读耗时(`820ms` / `3.4s`);null 显示「—」。 */
export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 用户消息折叠展示的字符上限(超出点「展开」看全文)。 */
export const AUDIT_MESSAGE_PREVIEW_CHARS = 120;

/** 稳定的空数组引用:喂给 useTablePage 时避免每次渲染都产生新引用触发 memo 失效。 */
const EMPTY_ROWS: never[] = [];

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
    <div className="flex min-w-0 flex-col">
      <div className="px-5 pt-5">
        <h2 className="text-[20px] font-semibold tracking-tight text-fg">把模型接到你的工具</h2>
        <p className="mt-1 text-caption text-muted">
          通过 API Key 连接 Claude Code 或 CC Switch,沿用本站模型与积分。
        </p>
      </div>

      {/* 区块顺序 = 用户动线:快速接入 → 密钥管理(以上在 ApiKeysSection 内)→ 用量概览 →
          最近明细(以上在 ApiKeyUsagePanel 内)→ 请求审计。 */}
      <ApiKeysSection auth={auth} onKeysChange={setKeys} />

      <ApiKeyUsagePanel auth={auth} keys={keys} />

      <ApiKeyAuditPanel auth={auth} keys={keys} />
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
  /** 「加载更多」追加的行(第一页永远来自 report.recent,不重复存)。 */
  const [moreRecent, setMoreRecent] = useState<ApiKeyUsageRecent[]>([]);
  /**
   * 下一页游标。`undefined` = 还没翻过页(是否有下一页由第一页是否满页推断);
   * `string` = 有下一页;`null` = 已到底。
   */
  const [recentBefore, setRecentBefore] = useState<string | null | undefined>(undefined);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentErr, setRecentErr] = useState<string | null>(null);

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
    // 窗口 / key 过滤变了,之前翻出来的分页结果与新条件无关,必须整体重置。
    setMoreRecent([]);
    setRecentBefore(undefined);
    setRecentErr(null);
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

  const recentRows = useMemo(
    () => (report ? [...report.recent, ...moreRecent] : []),
    [report, moreRecent],
  );
  /**
   * 还能不能再翻:翻过页就以服务端 `next_before` 为准;没翻过页时看第一页是否满
   * (不满 ⇒ 该窗口内已无更多行,不做一次注定为空的请求)。
   */
  const recentHasMore =
    recentBefore === undefined
      ? (report?.recent.length ?? 0) >= RECENT_FIRST_PAGE_SIZE
      : recentBefore !== null;

  const loadMoreRecent = useCallback(async () => {
    const last = recentRows[recentRows.length - 1];
    if (!last || recentLoading) return;
    const cursor = recentBefore === undefined ? last.id : recentBefore;
    if (cursor === null) return;
    setRecentLoading(true);
    setRecentErr(null);
    try {
      const qs = new URLSearchParams({
        window,
        before: cursor,
        limit: String(RECENT_PAGE_SIZE),
      });
      if (keyId !== ALL_KEYS) qs.set("key_id", keyId);
      const page = await getJson<ApiKeyUsageRecentPage>(
        auth,
        `/api/me/api-keys/usage/recent?${qs.toString()}`,
      );
      setMoreRecent((prev) => [...prev, ...page.entries]);
      setRecentBefore(page.next_before);
    } catch (e) {
      setRecentErr(apiErrorMessage(e, "加载更多明细失败"));
    } finally {
      setRecentLoading(false);
    }
  }, [auth, window, keyId, recentRows, recentBefore, recentLoading]);

  // 客户端分页(整份 by_key / by_model 已在内存里,每页 10 行;≤10 行时 TablePager 不渲染)。
  // Hook 必须无条件调用,故放在早退分支之前 —— report 为 null 时喂空数组。
  const byKeyPage = useTablePage<ApiKeyUsageByKey>(report?.by_key ?? EMPTY_ROWS);
  const byModelPage = useTablePage<UsageReportModel>(report?.by_model ?? EMPTY_ROWS);

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
    <div className="min-w-0 border-t border-border px-5 py-5" data-api-key-usage>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div className="text-section font-semibold text-fg">
          消耗统计 · 近 {REPORT_WINDOW_NOUN[window]}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
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

      <p className="mb-3 text-caption text-muted">
        仅统计外部 API 请求,不含网页对话。可按时间与密钥筛选。
      </p>

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
              <EmptyRow>
                该时段暂无 API Key 用量。用密钥跑一次 <code className="font-mono">claude</code>
                ,几秒后回来刷新即可看到。
              </EmptyRow>
            ) : (
              <TableShell caption={`按密钥用量,近 ${REPORT_WINDOW_NOUN[window]}`} minWidth="32rem">
                <thead className={THEAD_CLS}>
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
                  {byKeyPage.pageRows.map((row) => (
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
            <TablePager
              label="按密钥"
              page={byKeyPage.page}
              pageCount={byKeyPage.pageCount}
              onPageChange={byKeyPage.setPage}
            />

            <SubHeading>按模型</SubHeading>
            {report.by_model.length === 0 ? (
              <EmptyRow>该时段暂无模型用量。发起请求后这里按模型拆分输入/输出与积分。</EmptyRow>
            ) : (
              <TableShell caption={`按模型用量,近 ${REPORT_WINDOW_NOUN[window]}`} minWidth="36rem">
                <thead className={THEAD_CLS}>
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
                  {byModelPage.pageRows.map((model) => (
                    <tr key={model.model} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-fg">
                        {publicCursorModelId(model.model)}
                      </td>
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

            <TablePager
              label="按模型"
              page={byModelPage.page}
              pageCount={byModelPage.pageCount}
              onPageChange={byModelPage.setPage}
            />

            <SubHeading>最近明细</SubHeading>
            {recentRows.length === 0 ? (
              <EmptyRow>
                该时段暂无请求记录。换更长的时间窗口,或确认本机 Claude Code
                确实在用本站密钥(教程里的排查一节)。
              </EmptyRow>
            ) : (
              <TableShell
                caption={`最近 API Key 请求,近 ${REPORT_WINDOW_NOUN[window]}`}
                minWidth="36rem"
                maxHeight="28rem"
              >
                <thead className={THEAD_CLS}>
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
                  {recentRows.map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
                        {shortTime(row.created_at)}
                      </td>
                      <td className="max-w-[10rem] truncate px-3 py-2 text-fg">
                        {row.label ?? "(已撤销)"}
                      </td>
                      <td className="px-3 py-2 font-mono text-fg">
                        {publicCursorModelId(row.model)}
                      </td>
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

            {recentRows.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {recentHasMore ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={recentLoading}
                    onClick={() => void loadMoreRecent()}
                    data-testid="recent-load-more"
                  >
                    {recentLoading ? "加载中…" : "加载更多"}
                  </Button>
                ) : (
                  <span className="text-caption text-faint">已到底</span>
                )}
                <span className="text-caption text-faint tabular-nums">
                  已显示 {recentRows.length} 条
                </span>
                {/* <output> 天然是 role=status 的活动区域:翻页失败时读屏会播报,
                    且不必手写 role(biome a11y/useSemanticElements 也要求用语义元素)。 */}
                {recentErr && <output className="text-caption text-danger">{recentErr}</output>}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

/**
 * 请求审计面板(admin-only)。数据源 `GET /api/me/api-keys/messages`(0279):外接请求的
 * 最后一条用户输入(服务端已截到 ≤4KB)+ 请求指纹 + 模型/档位 + 结果。
 *
 * 后端本来就是 `requireAdmin`,非 admin 会 403;这里除了不给非 admin 渲染入口(父组件
 * SettingsCenter 已按角色过滤整个分区),还把 403 当作"整段隐藏"处理 —— 与
 * ApiKeysSection 的 403 兜底同一策略,角色变更竞态下不会留一条红色报错吓人。
 *
 * **安全**:用户消息是不可信输入,只能作为文本节点渲染(React 默认转义),
 * 绝不允许 dangerouslySetInnerHTML;`<pre>` 只负责保留换行/空白。
 */
export function ApiKeyAuditPanel({ auth, keys }: { auth: AuthSession; keys: ApiKeySummary[] }) {
  const [keyId, setKeyId] = useState<string>(ALL_KEYS);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [entries, setEntries] = useState<ApiKeyMessageAuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // 撤销后的 key 会从下拉里消失,同 usage 面板:回到「全部」。
  useEffect(() => {
    if (keyId !== ALL_KEYS && !keys.some((k) => k.id === keyId)) setKeyId(ALL_KEYS);
  }, [keys, keyId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick 是显式重试触发器。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    setEntries([]);
    setNextBefore(null);
    const qs = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
    if (keyId !== ALL_KEYS) qs.set("key_id", keyId);
    if (errorsOnly) qs.set("errors_only", "1");
    getJson<ApiKeyMessageAuditPage>(auth, `/api/me/api-keys/messages?${qs.toString()}`)
      .then((page) => {
        if (!alive) return;
        setEntries(page.entries);
        setNextBefore(page.next_before);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 403) {
          setHidden(true);
          return;
        }
        setErr(apiErrorMessage(e, "加载请求审计失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, keyId, errorsOnly, reloadTick]);

  const loadMore = useCallback(async () => {
    if (nextBefore === null || more) return;
    setMore(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({
        limit: String(AUDIT_PAGE_SIZE),
        before: nextBefore,
      });
      if (keyId !== ALL_KEYS) qs.set("key_id", keyId);
      if (errorsOnly) qs.set("errors_only", "1");
      const page = await getJson<ApiKeyMessageAuditPage>(
        auth,
        `/api/me/api-keys/messages?${qs.toString()}`,
      );
      setEntries((prev) => [...prev, ...page.entries]);
      setNextBefore(page.next_before);
    } catch (e) {
      setErr(apiErrorMessage(e, "加载更多审计失败"));
    } finally {
      setMore(false);
    }
  }, [auth, keyId, errorsOnly, nextBefore, more]);

  const keyOptions = useMemo(
    () => [
      { value: ALL_KEYS, label: "全部密钥" },
      ...keys.map((k) => ({
        value: k.id,
        label: k.disabledAt ? `${k.label}(已禁用)` : k.label,
      })),
    ],
    [keys],
  );

  if (hidden) return null;

  return (
    <div className="min-w-0 border-t border-border px-5 py-5" data-api-key-audit>
      <div className="flex flex-wrap items-center gap-2 pb-1">
        <div className="text-section font-semibold text-fg">请求审计</div>
        <div className="flex w-full flex-wrap items-center gap-3">
          <Select
            aria-label="审计按密钥过滤"
            value={keyId}
            onValueChange={setKeyId}
            options={keyOptions}
            inputSize="sm"
            className="w-40"
          />
          {/* Radix Switch 渲染的是 <button role="switch">,不是原生 input,包 <label> 关联不上
              (biome a11y/noLabelWithoutControl);文案单独用 <span> + aria-label 承担可访问名。 */}
          <span className="flex items-center gap-2 text-caption text-muted">
            <Switch
              aria-label="只看失败"
              checked={errorsOnly}
              onCheckedChange={(on) => setErrorsOnly(on === true)}
            />
            只看失败
          </span>
        </div>
      </div>

      <p className="mb-3 text-caption text-muted">
        每条外接请求的最后一条用户输入(服务端已截断)与结果。仅管理员可见,用于排查失败与滥用。
      </p>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[52px] rounded-xl" />
          ))}
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
      ) : entries.length === 0 ? (
        <EmptyRow>
          {errorsOnly
            ? "该筛选下没有失败请求 —— 这是好事。关掉「只看失败」可查看全部请求。"
            : "暂无审计记录。经 API Key 发起一次请求后,这里会出现它的输入与结果。"}
        </EmptyRow>
      ) : (
        <>
          <TableShell caption="外接请求审计" minWidth="44rem" maxHeight="32rem">
            <thead className={THEAD_CLS}>
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">密钥</th>
                <th className="px-3 py-2">模型</th>
                <th className="px-3 py-2">档位</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2 text-right">耗时</th>
                <th className="px-3 py-2">用户消息</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <AuditRow key={e.id} entry={e} keys={keys} />
              ))}
            </tbody>
          </TableShell>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {nextBefore !== null ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={more}
                onClick={() => void loadMore()}
                data-testid="audit-load-more"
              >
                {more ? "加载中…" : "加载更多"}
              </Button>
            ) : (
              <span className="text-caption text-faint">已到底</span>
            )}
            <span className="text-caption text-faint tabular-nums">已显示 {entries.length} 条</span>
          </div>
        </>
      )}
    </div>
  );
}

/** 审计单行。用户消息默认截断到 120 字,点「展开」看全文(纯文本节点,不解释 HTML)。 */
function AuditRow({ entry, keys }: { entry: ApiKeyMessageAuditEntry; keys: ApiKeySummary[] }) {
  const [open, setOpen] = useState(false);
  const msg = entry.last_user_message ?? "";
  const long = msg.length > AUDIT_MESSAGE_PREVIEW_CHARS;
  const label = keys.find((k) => k.id === entry.api_key_id)?.label ?? "(已撤销)";
  const ok = entry.status === "success";
  return (
    <tr className="border-t border-border align-top">
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
        {shortTime(entry.created_at)}
      </td>
      <td className="max-w-[8rem] truncate px-3 py-2 text-fg">{label}</td>
      <td className="px-3 py-2 font-mono text-fg">{publicCursorModelId(entry.model)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">
        {effortLabel(entry.effort, entry.effort_source)}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-caption",
            ok ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
          )}
        >
          {ok ? "成功" : (entry.terminal_code ?? entry.status)}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">
        {durationLabel(entry.duration_ms)}
      </td>
      <td className="px-3 py-2">
        {msg === "" ? (
          <span className="text-faint">—</span>
        ) : (
          // React 把字符串当文本节点渲染并自动转义:<script> 等内容只会显示成字面量。
          // 这里刻意**不**用 dangerouslySetInnerHTML —— 用户消息是不可信输入。
          <pre
            className="max-w-[22rem] whitespace-pre-wrap break-words font-sans text-meta text-fg"
            data-testid="audit-message"
          >
            {open || !long ? msg : `${msg.slice(0, AUDIT_MESSAGE_PREVIEW_CHARS)}…`}
          </pre>
        )}
        {long && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 rounded px-1 text-caption text-accent underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? "收起" : "展开"}
          </button>
        )}
        {entry.last_user_message_truncated && (
          <span className="ml-1 text-caption text-faint">(服务端已截断)</span>
        )}
        {entry.error_message && (
          <p className="mt-1 text-caption text-danger" data-testid="audit-error">
            {entry.error_message}
          </p>
        )}
      </td>
    </tr>
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

/**
 * 表头样式(所有表共用一处)。`sticky top-0` 让长表纵向滚动时表头留在视口内 ——
 * 生效前提是滚动容器有高度上限,见 TableShell 的 maxHeight。
 */
const THEAD_CLS =
  "sticky top-0 z-10 bg-hover text-caption font-medium uppercase tracking-wide text-faint";

/**
 * 表格外壳。
 *  - 横向:`overflow-x-auto` + `minWidth` —— 移动端(390px)表自身可以更宽,但溢出被这个
 *    容器吃掉、内部横向滚动,**页面本身不产生横向滚动条**(外层各级都有 min-w-0)。
 *  - 纵向:`maxHeight` 给长表封顶并让 sticky 表头有意义;短表不传就不封顶。
 */
function TableShell({
  caption,
  minWidth,
  maxHeight,
  children,
}: {
  caption: string;
  minWidth: string;
  /** 传了才封顶(长表);不传则随内容高度。 */
  maxHeight?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overflow-auto rounded-xl border border-border"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className="w-full text-left text-meta" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-hover/60 px-4 py-3">
      <div className="text-caption text-faint">{label}</div>
      <div
        className={cn(
          "mt-1 text-[20px] font-semibold tabular-nums",
          accent ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}
