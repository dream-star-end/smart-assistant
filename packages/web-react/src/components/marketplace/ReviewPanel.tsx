import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol";
import { Check, ChevronRight, FlaskConical, Inbox, ShieldX, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { benchmarkSuspect, bundleHasEvals } from "../../lib/marketplace";
import type {
  AuthSession,
  MarketplaceAiReview,
  MarketplaceCard,
  MarketplacePending,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyChip,
  EmptyState,
  Field,
  Input,
  ListSkeleton,
  Panel,
  Textarea,
  TimeAgo,
  useConfirm,
  usePrompt,
  useToast,
} from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

/** 人向元数据是否缺失(存量/平台 seed 行没有 category 或 useCases)。 */
function humanMetaMissing(r: MarketplacePending): boolean {
  return !isMarketplaceCategoryId(r.category) || !(r.useCases && r.useCases.length > 0);
}

/** 已排队多少天(FIFO 队列的积压感知;不足 1 天返 0)。 */
function waitedDays(createdAt: string): number {
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** 审核展开区:人向商品元数据(分类/适用场景/效果示例/详细介绍)只读展示。 */
function PendingHumanMeta({ r }: { r: MarketplacePending }) {
  const useCases = Array.isArray(r.useCases) ? r.useCases.filter((s) => s.trim()) : [];
  const outcomes = Array.isArray(r.outcomeExamples)
    ? r.outcomeExamples.filter((s) => s.trim())
    : [];
  const humanMd = r.humanMd?.trim();
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-meta leading-relaxed">
      <div>
        <span className="font-medium text-muted">分类：</span>
        <span className="text-fg">{marketplaceCategoryLabel(r.category)}</span>
      </div>
      <div>
        <span className="font-medium text-muted">适用场景：</span>
        {useCases.length > 0 ? (
          <ul className="mt-0.5 list-disc pl-5 text-fg">
            {useCases.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        ) : (
          <span className="text-faint">未提供</span>
        )}
      </div>
      {outcomes.length > 0 && (
        <div>
          <span className="font-medium text-muted">效果示例：</span>
          <ul className="mt-0.5 list-disc pl-5 text-fg">
            {outcomes.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </div>
      )}
      {humanMd && (
        <div>
          <span className="font-medium text-muted">详细介绍：</span>
          <div className="mt-0.5 text-fg">
            <Markdown>{humanMd}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 管理员审核：待审队列(批准 / 拒绝须附理由——理由回显给发布者的「我的发布」)
 * + 下架(kill-switch)。后端 requireAdminVerifyDb 二次把关。
 *
 * ── 2026-07-26 面板层改造的三条判断 ─────────────────────────────────────
 *  1. **kill-switch 提到顶部独立分区**:紧急下架是本面板最危险、最需要秒到的操作,
 *     压在 30 条待审队列末尾等于没有。
 *  2. **前置条件可见化**:连接器未完成功能验收时,「批准」不再是一个点了报错的按钮,
 *     而是变成「展开审查」并把原因写在行内 —— 错误不能只在长列表顶部飘一条。
 *  3. **徽章语义分层**:版本号是中性事实(降为文本),缺陷用 warning,供给信号用 info;
 *     徽章位只留需要人做判断的东西。
 */
export function ReviewPanel({ auth }: { auth: AuthSession }) {
  const [rows, setRows] = useState<MarketplacePending[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connectorDecisions, setConnectorDecisions] = useState<Record<string, string>>({});
  const [connectorVerified, setConnectorVerified] = useState<Set<string>>(new Set());
  // 单条操作的失败原因**留在那一行**,不再冲到面板顶部(队列长时早已滚出视口)。
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [batchResult, setBatchResult] = useState<{
    reviewed: number;
    failures: Array<{ versionId: string; name: string; message?: string }>;
  } | null>(null);
  const [promptText, promptTextEl] = usePrompt();
  const [confirmDialog, confirmEl] = useConfirm();
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .adminMarketplacePending(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr(apiErrorMessage(e, "加载待审失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const setRowError = useCallback((versionId: string, message: string | null) => {
    setRowErrors((prev) => {
      if (message === null) {
        if (!(versionId in prev)) return prev;
        const next = { ...prev };
        delete next[versionId];
        return next;
      }
      return { ...prev, [versionId]: message };
    });
  }, []);

  const review = useCallback(
    async (versionId: string, decision: "approve" | "reject") => {
      const row = rows?.find((r) => r.versionId === versionId);
      let note: string | undefined;
      if (decision === "reject") {
        // 拒绝必须给理由:回显到发布者「我的发布」,否则拒绝对发布者是黑盒。
        const reason = await promptText({
          title: "拒绝理由",
          body: "理由会展示给发布者，请写明需要修正什么。",
          placeholder: "例：正文包含内网地址，请移除后重新提交",
          confirmText: "拒绝",
          maxLength: 500,
        });
        if (reason === null) return;
        note = reason;
      }
      // busy 带上动作:批准与拒绝各自的按钮才能显示自己的忙态(旧实现只有批准有 spinner)。
      setBusy(`${decision}:${versionId}`);
      setRowError(versionId, null);
      try {
        if (row?.kind === "connector" && decision === "approve") {
          // 兜底不变量:functionalVerified 只能由勾选过验收的路径发出。UI 已把未验收的
          // 「批准」换成「展开审查」,这里再守一道 —— 安全前提不该只由渲染分支保证。
          if (!connectorVerified.has(versionId)) {
            setOpen(versionId);
            setRowError(versionId, "批准 API 插件前，必须先确认已使用隔离账号完成真实功能验收。");
            return;
          }
          const suggested = (row.manifest as { proposedSecurityDecision?: unknown } | null)
            ?.proposedSecurityDecision;
          let actual: unknown;
          try {
            actual = JSON.parse(
              connectorDecisions[versionId] ?? JSON.stringify(suggested ?? {}, null, 2),
            );
          } catch {
            // 校验失败必须看得见:把行展开,错误就落在 SecurityDecision 框上方。
            setOpen(versionId);
            setRowError(versionId, "实际 SecurityDecision 不是合法 JSON，请修正后再批准。");
            return;
          }
          if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
            setOpen(versionId);
            setRowError(versionId, "实际 SecurityDecision 必须是 JSON 对象。");
            return;
          }
          await api.adminMarketplaceReview(auth, versionId, decision, note, {
            securityDecision: actual as Record<string, unknown>,
            expectedSpecHash: row.artifactHash,
            functionalVerified: true,
          });
        } else {
          await api.adminMarketplaceReview(auth, versionId, decision, note);
        }
        setReload((n) => n + 1);
        toast(
          `已${decision === "approve" ? "批准" : "拒绝"}「${row?.name ?? ""}」v${row?.version ?? ""}`,
          "success",
        );
      } catch (e) {
        setRowError(versionId, apiErrorMessage(e, "审核失败"));
      } finally {
        setBusy(null);
      }
    },
    [auth, connectorDecisions, connectorVerified, promptText, rows, setRowError, toast],
  );

  const batchReview = useCallback(
    async (decision: "approve" | "reject") => {
      const targets = (rows || []).filter((r) => selected.has(r.versionId));
      if (targets.length === 0) return;
      const versionIds = targets.map((r) => r.versionId);
      let note: string | undefined;
      if (decision === "reject") {
        const reason = await promptText({
          title: `批量拒绝 ${versionIds.length} 个投稿`,
          body: "理由会展示给这些发布者，请写明需要修正什么。",
          placeholder: "例：正文包含内网地址，请移除后重新提交",
          confirmText: "批量拒绝",
          maxLength: 500,
        });
        if (reason === null) return;
        note = reason;
      } else {
        // 批准 = 立即向全体用户上架,事后只能靠 kill-switch 补救 —— 门槛不该比拒绝还低。
        const go = await confirmDialog({
          title: `批准 ${versionIds.length} 个投稿并立即上架？`,
          body: "上架后所有用户可见，撤回需要走下架。",
          confirmText: "批准",
        });
        if (!go) return;
      }
      setBusy(`batch:${decision}`);
      setErr(null);
      setBatchResult(null);
      try {
        const r = await api.adminMarketplaceReviewBatch(auth, versionIds, decision, note);
        setReload((n) => n + 1);
        const failures = (r.results ?? [])
          .filter((x) => !x.ok)
          .map((x) => ({
            versionId: x.versionId,
            name: targets.find((t) => t.versionId === x.versionId)?.name ?? x.versionId,
            message: x.message,
          }));
        if (failures.length === 0) {
          setSelected(new Set());
          toast(`已${decision === "approve" ? "批准" : "拒绝"} ${r.reviewed} 个投稿`, "success");
        } else {
          // 失败项留在选择集里,管理员可以直接重试,不必靠"谁还在列表里"倒推。
          setSelected(new Set(failures.map((f) => f.versionId)));
          setBatchResult({ reviewed: r.reviewed, failures });
        }
      } catch (e) {
        setErr(apiErrorMessage(e, "批量审核失败"));
      } finally {
        setBusy(null);
      }
    },
    [auth, confirmDialog, promptText, rows, selected, toast],
  );

  const visibleIds = useMemo(() => rows?.map((r) => r.versionId) ?? [], [rows]);
  const selectedVisibleIds = visibleIds.filter((id) => selected.has(id));
  const selectedHasConnector = (rows ?? []).some(
    (r) => selected.has(r.versionId) && r.kind === "connector",
  );
  const allSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;
  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(visibleIds) : new Set());
  };
  const toggleOne = (versionId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(versionId);
      else next.delete(versionId);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {promptTextEl}
      {confirmEl}

      <RevokeBox auth={auth} />

      <Panel
        title={`待审队列${rows ? `（${rows.length}）` : ""}`}
        hint="按提交时间先到先审；批准后立即对所有用户上架。"
        action={
          <Button
            size="sm"
            variant="secondary"
            loading={loading && rows !== null}
            onClick={() => setReload((n) => n + 1)}
          >
            刷新
          </Button>
        }
        bodyClassName="flex flex-col gap-3 p-3.5"
      >
        {err && (
          <Alert
            tone="danger"
            density="compact"
            action={
              <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        )}

        {loading && !rows ? (
          <ListSkeleton rows={4} />
        ) : !rows || rows.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="暂无待审版本"
            hint="用户提交发布后会出现在这里，按提交时间排队。"
            action={
              <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                刷新队列
              </Button>
            }
          />
        ) : (
          <>
            {batchResult && (
              <Alert
                tone="warning"
                density="compact"
                title={`批量处理部分失败：${batchResult.reviewed} 成功，${batchResult.failures.length} 失败`}
                onDismiss={() => setBatchResult(null)}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setSelected(new Set(batchResult.failures.map((f) => f.versionId)))
                    }
                  >
                    只保留失败项
                  </Button>
                }
              >
                <ul className="list-disc pl-4">
                  {batchResult.failures.map((f) => (
                    <li key={f.versionId}>
                      {f.name}
                      {f.message ? `：${f.message}` : ""}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <label className="flex items-center gap-2 text-body text-muted [@media(hover:none)]:min-h-11">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisibleIds.length > 0 && !allSelected;
                  }}
                  onChange={(e) => toggleAll(e.currentTarget.checked)}
                />
                全选
              </label>
              <span className="text-meta text-faint">已选 {selectedVisibleIds.length}</span>
              {selectedHasConnector && (
                // 禁用原因不能只写在 native title:disabled 元素多数浏览器不触发它,触屏则完全无从呈现。
                <span className="text-caption text-warning">
                  API 插件需逐个填写实际安全决策并确认功能验收，不能批量批准
                </span>
              )}
              <div className="ms-auto flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void batchReview("reject")}
                  loading={busy === "batch:reject"}
                  disabled={selectedVisibleIds.length === 0 || busy !== null}
                >
                  批量拒绝
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void batchReview("approve")}
                  loading={busy === "batch:approve"}
                  disabled={
                    selectedVisibleIds.length === 0 || selectedHasConnector || busy !== null
                  }
                >
                  批量批准
                </Button>
              </div>
            </div>

            <ul className="flex flex-col gap-2">
              {rows.map((r) => {
                const isOpen = open === r.versionId;
                const flags = friendlyRiskFlags(r.riskFlags);
                const rowErr = rowErrors[r.versionId];
                const approving = busy === `approve:${r.versionId}`;
                const rejecting = busy === `reject:${r.versionId}`;
                const otherBusy = busy !== null && !approving && !rejecting;
                const waited = waitedDays(r.createdAt);
                // 连接器的批准前置条件:真实功能验收在展开区,未勾选前"批准"不可点。
                const needsReview = r.kind === "connector" && !connectorVerified.has(r.versionId);
                return (
                  <li
                    key={r.versionId}
                    className={cn(
                      "overflow-hidden rounded-xl border border-border bg-elevated transition-opacity",
                      otherBusy && "opacity-60",
                    )}
                  >
                    <div className="flex flex-wrap items-start gap-2 px-3.5 py-3">
                      <input
                        type="checkbox"
                        className="mt-1 accent-accent"
                        checked={selected.has(r.versionId)}
                        onChange={(e) => toggleOne(r.versionId, e.currentTarget.checked)}
                        aria-label={`选择 ${r.name}`}
                      />
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : r.versionId)}
                        aria-expanded={isOpen}
                        aria-controls={`review-detail-${r.versionId}`}
                        className="flex min-w-0 flex-1 basis-48 items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronRight
                          size={15}
                          className={cn(
                            "mt-0.5 shrink-0 text-faint transition-transform",
                            isOpen && "rotate-90",
                          )}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-section font-medium text-fg">
                              {r.name}
                            </span>
                            {/* 版本号是中性事实,不占徽章位 —— 徽章留给需要判断的信号。 */}
                            <span className="shrink-0 text-caption text-faint">v{r.version}</span>
                            {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                            {r.kind === "connector" && (
                              <Badge tone="info">API 插件 · 人工安全审</Badge>
                            )}
                            {waited >= 1 && <Badge tone="warning">等待 {waited} 天</Badge>}
                            {/* 存量/平台 seed 行缺人向元数据 → 缺陷提示(非阻断,仅提示补齐)。 */}
                            {humanMetaMissing(r) && <Badge tone="warning">人向元数据缺失</Badge>}
                            {/* 供给凸显:附带 evals/ 评测用例 → 正向信号(鼓励供给,不做质量背书)。 */}
                            {bundleHasEvals(r.rawBundle) && (
                              <Badge
                                tone="info"
                                title="附带 evals/ 评测用例（发布者提供，未复跑验证）"
                              >
                                <FlaskConical size={11} />带 evals
                              </Badge>
                            )}
                            {flags.length > 0 && <Badge tone="warning">{flags.length} 项提示</Badge>}
                            {/* 自报评测黄牌:增益≤0 或通过率<50% 时提示人审留意;数据为发布者
                                自报、未经平台验证,仅提示不阻断。无 benchmark 不渲染。 */}
                            {benchmarkSuspect(r.benchmark) && r.benchmark && (
                              <Badge
                                tone="warning"
                                title={`自报实测 ${Math.round(r.benchmark.withoutPassRate * 100)}%→${Math.round(r.benchmark.withPassRate * 100)}%（${r.benchmark.cases} 用例）：增益≤0 或通过率<50%。发布者提供·未经平台验证`}
                              >
                                自报增益存疑
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-meta text-muted">
                            {r.slug} ·{" "}
                            <TimeAgo value={r.createdAt} tooltip={false} className="tabular-nums" />
                            提交 · 提交者 #{r.submittedBy}
                          </p>
                          {needsReview && (
                            <p className="mt-0.5 text-caption text-warning">
                              需先在展开区核对安全决策并确认真实功能验收，才能批准。
                            </p>
                          )}
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:justify-end">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void review(r.versionId, "reject")}
                          loading={rejecting}
                          disabled={otherBusy}
                        >
                          {rejecting ? null : <X size={14} />}
                          拒绝
                        </Button>
                        {needsReview ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setOpen(r.versionId)}
                            disabled={otherBusy}
                          >
                            展开审查
                          </Button>
                        ) : (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void review(r.versionId, "approve")}
                            loading={approving}
                            disabled={otherBusy}
                          >
                            {approving ? null : <Check size={14} />}
                            批准
                          </Button>
                        )}
                      </div>
                    </div>

                    {rowErr && (
                      <div className="border-t border-border px-3.5 py-2">
                        <Alert
                          tone="danger"
                          density="compact"
                          onDismiss={() => setRowError(r.versionId, null)}
                        >
                          {rowErr}
                        </Alert>
                      </div>
                    )}

                    {isOpen && (
                      <div
                        id={`review-detail-${r.versionId}`}
                        className="border-t border-border px-3.5 py-3"
                      >
                        <p className="mb-2 text-body text-fg">{r.description}</p>
                        {/* 人向商品元数据:审核要点=分类名实相符、用例与正文一致、效果不夸大。 */}
                        <PendingHumanMeta r={r} />
                        {r.kind === "connector" && (
                          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 p-3">
                            <Field
                              label="实际 SecurityDecision"
                              hint="下方初值来自发布者建议，不是平台事实。请核对每个 origin 与 action effect 后再批准。"
                            >
                              <Textarea
                                rows={10}
                                className="resize-y font-mono"
                                value={
                                  connectorDecisions[r.versionId] ??
                                  JSON.stringify(
                                    (r.manifest as { proposedSecurityDecision?: unknown } | null)
                                      ?.proposedSecurityDecision ?? {},
                                    null,
                                    2,
                                  )
                                }
                                onChange={(e) =>
                                  setConnectorDecisions((prev) => ({
                                    ...prev,
                                    [r.versionId]: e.target.value,
                                  }))
                                }
                              />
                            </Field>
                            <label className="flex items-start gap-2 text-meta leading-relaxed text-fg">
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-accent"
                                checked={connectorVerified.has(r.versionId)}
                                onChange={(e) =>
                                  setConnectorVerified((prev) => {
                                    const next = new Set(prev);
                                    if (e.currentTarget.checked) next.add(r.versionId);
                                    else next.delete(r.versionId);
                                    return next;
                                  })
                                }
                              />
                              我已使用隔离测试账号完成绑定、身份探针及声明动作的真实功能验收。
                            </label>
                          </div>
                        )}
                        {/* AI 意见(供参考):escalate/warn 降级/解析失败时 AI 给出的转人工原因。
                          仅在待审队列里出现的项 = AI 未直接放行,人审据此复核。 */}
                        {r.aiNote && (
                          <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-2">
                            <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" />
                            <p className="text-meta leading-relaxed text-fg">
                              <span className="font-medium text-accent">AI 意见（供参考）：</span>
                              {r.aiNote}
                            </p>
                          </div>
                        )}
                        {flags.length > 0 && (
                          <div className="mb-2 flex flex-col gap-1.5">
                            {flags.map((f) => (
                              <Alert key={f.label} tone={f.tone} density="compact">
                                <span className="font-medium">{f.label}：</span>
                                {f.message}
                                {f.sample && (
                                  <code className="mt-1 block break-all rounded bg-code px-1.5 py-0.5 font-mono text-caption">
                                    {f.sample}
                                  </code>
                                )}
                              </Alert>
                            ))}
                          </div>
                        )}
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-meta font-medium text-muted">原始工件</span>
                          <CopyChip value={r.rawArtifact} label="复制全文" mono={false} />
                        </div>
                        <pre
                          aria-label="原始工件内容，可滚动"
                          // biome-ignore lint/a11y/noNoninteractiveTabindex: 嵌套滚动区必须能被键盘聚焦后滚动。
                          tabIndex={0}
                          className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-meta leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                          {r.rawArtifact}
                        </pre>
                        {r.benchmark && (
                          <p className="mt-2 text-meta text-muted">
                            发布者自报实测：通过率{" "}
                            {Math.round(r.benchmark.withoutPassRate * 100)}% →{" "}
                            {Math.round(r.benchmark.withPassRate * 100)}%（{r.benchmark.cases}{" "}
                            用例；未经平台验证）
                          </p>
                        )}
                        {r.rawBundle &&
                          Object.entries(r.rawBundle).map(([path, content]) => (
                            <details key={path} className="mt-2">
                              <summary className="cursor-pointer rounded-md font-mono text-caption text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
                                附属文件：{path}（{content.length} 字）
                              </summary>
                              <pre
                                aria-label={`${path} 内容，可滚动`}
                                // biome-ignore lint/a11y/noNoninteractiveTabindex: 同上,嵌套滚动区需可键盘聚焦。
                                tabIndex={0}
                                className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-caption text-fg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              >
                                {content}
                              </pre>
                            </details>
                          ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>

      <AiReviewLog auth={auth} reloadKey={reload} />
    </div>
  );
}

/**
 * AI 审批记录（折叠）：AI 已自动 approve/reject 的版本（review_source='ai'）。
 * escalate 项不在此（它们仍 pending，在上方待审队列以「AI 意见」呈现）。admin 覆盖权:
 * 误批可用顶部 kill-switch 下架；escalate 天然进人审队列。默认折叠,展开时才拉取。
 */
function AiReviewLog({ auth, reloadKey }: { auth: AuthSession; reloadKey: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MarketplaceAiReview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .adminMarketplaceAiReviews(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr(apiErrorMessage(e, "加载 AI 审批记录失败")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, open, reloadKey, reload]);

  return (
    <Card padding="md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="ai-review-log"
        className="flex w-full items-center gap-1.5 rounded-md text-left text-body font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          size={15}
          className={cn("shrink-0 text-faint transition-transform", open && "rotate-90")}
        />
        <Sparkles size={15} className="text-accent" />
        AI 审批记录
        <span className="ml-1 text-caption font-normal text-faint">
          （AI 自动批准/拒绝的版本；转人工的项见上方待审队列）
        </span>
      </button>
      {open && (
        <div id="ai-review-log" className="mt-3">
          {err && (
            <Alert
              tone="danger"
              density="compact"
              action={
                <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                  重试
                </Button>
              }
            >
              {err}
            </Alert>
          )}
          {loading ? (
            <ListSkeleton rows={3} />
          ) : !rows || rows.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="暂无 AI 自动审批记录"
              hint="AI 直接批准或拒绝的版本会记在这里；转人工的项在上方待审队列。"
              action={
                <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                  刷新
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li
                  key={r.versionId}
                  className="rounded-lg border border-border bg-elevated px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-body font-medium text-fg">{r.name}</span>
                    <span className="shrink-0 text-caption text-faint">v{r.version}</span>
                    {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                    <Badge tone={r.status === "approved" ? "success" : "danger"}>
                      {r.status === "approved" ? "已批准" : "已拒绝"}
                    </Badge>
                    {r.reviewedAt && (
                      <TimeAgo
                        value={r.reviewedAt}
                        className="ml-auto shrink-0 text-caption text-faint"
                      />
                    )}
                  </div>
                  <p className="mt-0.5 text-caption text-muted">{r.slug}</p>
                  {r.aiNote && (
                    <p className="mt-1 text-meta leading-relaxed text-fg">
                      <span className="font-medium text-accent">AI：</span>
                      {r.aiNote}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * 下架(kill-switch)：撤销一个已上架条目,下次容器同步自动从所有用户移除。
 * **本面板置顶** —— 它是这里最危险、也最需要在紧急情况下秒到的操作,不该排在
 * 30 条待审队列之后。slug 输入带已上架目录 datalist 提示(技能+智能体+连接器),
 * 确认框回显条目名防误下架。
 */
function RevokeBox({ auth }: { auth: AuthSession }) {
  const [slug, setSlug] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [catalog, setCatalog] = useState<MarketplaceCard[]>([]);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  // 拉一次已上架目录做 datalist(两类各拉一页;搜索目录本身有 500 上限,极端时仍可手输)。
  useEffect(() => {
    let alive = true;
    Promise.all([
      api
        .searchMarketplace(auth, "", "skill", 50)
        .catch(() => ({ results: [] as MarketplaceCard[] })),
      api
        .searchMarketplace(auth, "", "agent", 50)
        .catch(() => ({ results: [] as MarketplaceCard[] })),
      api
        .searchMarketplace(auth, "", "connector", 50)
        .catch(() => ({ results: [] as MarketplaceCard[] })),
    ]).then(([s, a, c]) => {
      if (alive) setCatalog([...s.results, ...a.results, ...c.results]);
    });
    return () => {
      alive = false;
    };
  }, [auth]);

  const revoke = async () => {
    const target = slug.trim();
    if (!target) return;
    const known = catalog.find((c) => c.slug === target);
    const ok = await confirmDialog({
      title: `下架「${known ? `${known.name}（${target}）` : target}」？`,
      body: "所有已安装用户将在下次会话被移除该条目。",
      confirmText: "下架",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.adminMarketplaceRevoke(auth, target, reason.trim() || undefined);
      setMsg({ tone: "success", text: `已下架，影响 ${r.affectedInstalls} 个已安装用户。` });
      setSlug("");
      setReason("");
    } catch (e) {
      setMsg({ tone: "danger", text: apiErrorMessage(e, "下架失败") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3.5">
      {confirmDialogEl}
      <div className="mb-1 flex items-center gap-1.5 text-body font-medium text-danger">
        <ShieldX size={15} /> 紧急下架已上架条目（kill-switch）
      </div>
      <p className="mb-2 text-caption text-muted">
        撤销一个已上架条目：所有已安装用户在下次会话同步时被移除。
      </p>
      {msg && (
        <div className="mb-2">
          <Alert tone={msg.tone} density="compact">
            {msg.text}
          </Alert>
        </div>
      )}
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug"
          aria-label="要下架的条目 slug"
          list="revoke-slug-options"
        />
        <datalist id="revoke-slug-options">
          {catalog.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}（{c.kind === "agent" ? "智能体" : c.kind === "connector" ? "API 插件" : "技能"}
              ）
            </option>
          ))}
        </datalist>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="下架原因（可选）"
          aria-label="下架原因"
        />
        <Button variant="danger" onClick={() => void revoke()} loading={busy} disabled={!slug.trim()}>
          下架
        </Button>
      </div>
    </div>
  );
}
