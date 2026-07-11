import { isMarketplaceCategoryId, marketplaceCategoryLabel } from "@openclaude/protocol";
import { Check, ChevronRight, Inbox, Loader2, ShieldX, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { benchmarkSuspect, bundleHasEvals } from "../../lib/marketplace";
import type {
  AuthSession,
  MarketplaceAiReview,
  MarketplaceCard,
  MarketplacePending,
} from "../../lib/types";
import { Markdown } from "../Markdown";
import { Alert, Badge, Button, EmptyState, Input, Spinner, useConfirm, usePrompt } from "../ui";
import { friendlyRiskFlags } from "./riskFlags";

/** 人向元数据是否缺失(存量/平台 seed 行没有 category 或 useCases)。 */
function humanMetaMissing(r: MarketplacePending): boolean {
  return !isMarketplaceCategoryId(r.category) || !(r.useCases && r.useCases.length > 0);
}

/** 审核展开区:人向商品元数据(分类/适用场景/效果示例/详细介绍)只读展示。 */
function PendingHumanMeta({ r }: { r: MarketplacePending }) {
  const useCases = Array.isArray(r.useCases) ? r.useCases.filter((s) => s.trim()) : [];
  const outcomes = Array.isArray(r.outcomeExamples) ? r.outcomeExamples.filter((s) => s.trim()) : [];
  const humanMd = r.humanMd?.trim();
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-[12px] leading-relaxed">
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
 */
export function ReviewPanel({ auth }: { auth: AuthSession }) {
  const [rows, setRows] = useState<MarketplacePending[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [promptText, promptTextEl] = usePrompt();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .adminMarketplacePending(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message || "加载待审失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const review = useCallback(
    async (versionId: string, decision: "approve" | "reject") => {
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
      setBusy(versionId);
      setErr(null);
      try {
        await api.adminMarketplaceReview(auth, versionId, decision, note);
        setReload((n) => n + 1);
      } catch (e) {
        setErr((e as Error).message || "审核失败");
      } finally {
        setBusy(null);
      }
    },
    [auth, promptText],
  );

  const batchReview = useCallback(
    async (decision: "approve" | "reject") => {
      const versionIds = (rows || [])
        .filter((r) => selected.has(r.versionId))
        .map((r) => r.versionId);
      if (versionIds.length === 0) return;
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
      }
      setBusy(`batch:${decision}`);
      setErr(null);
      try {
        const r = await api.adminMarketplaceReviewBatch(auth, versionIds, decision, note);
        setSelected(new Set());
        setReload((n) => n + 1);
        if (r.failed > 0) setErr(`批量处理完成：${r.reviewed} 成功，${r.failed} 失败。`);
      } catch (e) {
        setErr((e as Error).message || "批量审核失败");
      } finally {
        setBusy(null);
      }
    },
    [auth, promptText, rows, selected],
  );

  const visibleIds = rows?.map((r) => r.versionId) || [];
  const selectedVisibleIds = visibleIds.filter((id) => selected.has(id));
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
    <div className="flex flex-col">
      {promptTextEl}
      {err && (
        <div className="px-4 pt-3">
          <Alert tone="danger">{err}</Alert>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-faint">
          <Spinner /> 加载待审…
        </div>
      ) : !rows || rows.length === 0 ? (
        <EmptyState icon={Inbox} title="暂无待审版本" hint="用户提交发布后会出现在这里。" />
      ) : (
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selectedVisibleIds.length > 0 && !allSelected;
                }}
                onChange={(e) => toggleAll(e.currentTarget.checked)}
              />
              全选
            </label>
            <span className="text-[12px] text-faint">已选 {selectedVisibleIds.length}</span>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => batchReview("reject")}
                disabled={selectedVisibleIds.length === 0 || busy !== null}
              >
                批量拒绝
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => batchReview("approve")}
                disabled={selectedVisibleIds.length === 0 || busy !== null}
              >
                {busy === "batch:approve" ? <Loader2 size={14} className="animate-spin" /> : null}
                批量批准
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const isOpen = open === r.versionId;
              const flags = friendlyRiskFlags(r.riskFlags);
              return (
                <li
                  key={r.versionId}
                  className="overflow-hidden rounded-xl border border-border bg-elevated"
                >
                  <div className="flex items-center gap-2 px-3.5 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.versionId)}
                      onChange={(e) => toggleOne(r.versionId, e.currentTarget.checked)}
                      aria-label={`选择 ${r.name}`}
                    />
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : r.versionId)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                    >
                      <ChevronRight
                        size={15}
                        className={`shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-fg">{r.name}</span>
                          {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                          <Badge tone="neutral">v{r.version}</Badge>
                          {/* 存量/平台 seed 行缺人向元数据 → 中性提示徽章(非阻断,仅提示补齐)。 */}
                          {humanMetaMissing(r) && <Badge tone="neutral">人向元数据缺失</Badge>}
                          {/* 供给凸显:附带 evals/ 评测用例 → 中性徽章(鼓励供给,不做质量背书)。 */}
                          {bundleHasEvals(r.rawBundle) && (
                            <Badge tone="neutral" title="附带 evals/ 评测用例（发布者提供，未复跑验证）">
                              带 evals
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
                        <p className="truncate text-[12px] text-muted">
                          {r.slug} · 提交者 #{r.submittedBy}
                        </p>
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => review(r.versionId, "reject")}
                      disabled={busy !== null}
                      aria-label="拒绝"
                    >
                      <X size={15} />
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => review(r.versionId, "approve")}
                      disabled={busy !== null}
                    >
                      {busy === r.versionId ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                      批准
                    </Button>
                  </div>

                {isOpen && (
                  <div className="border-t border-border px-3.5 py-3">
                    <p className="mb-2 text-[12.5px] text-fg">{r.description}</p>
                    {/* 人向商品元数据:审核要点=分类名实相符、用例与正文一致、效果不夸大。 */}
                    <PendingHumanMeta r={r} />
                    {/* AI 意见(供参考):escalate/warn 降级/解析失败时 AI 给出的转人工原因。
                        仅在待审队列里出现的项 = AI 未直接放行,人审据此复核。 */}
                    {r.aiNote && (
                      <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-2">
                        <Sparkles size={14} className="mt-0.5 shrink-0 text-accent" />
                        <p className="text-[12px] leading-relaxed text-fg">
                          <span className="font-medium text-accent">AI 意见（供参考）：</span>
                          {r.aiNote}
                        </p>
                      </div>
                    )}
                    {flags.length > 0 && (
                      <div className="mb-2 flex flex-col gap-1.5">
                        {flags.map((f) => (
                          <Alert key={f.label} tone={f.tone}>
                            <span className="font-medium">{f.label}：</span>
                            {f.message}
                            {f.sample && (
                              <code className="mt-1 block break-all rounded bg-code px-1.5 py-0.5 text-[11px]">
                                {f.sample}
                              </code>
                            )}
                          </Alert>
                        ))}
                      </div>
                    )}
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
                      {r.rawArtifact}
                    </pre>
                    {r.benchmark && (
                      <p className="mt-2 text-[12px] text-muted">
                        发布者自报实测:通过率 {Math.round(r.benchmark.withoutPassRate * 100)}% →{" "}
                        {Math.round(r.benchmark.withPassRate * 100)}%（{r.benchmark.cases} 用例;未经平台验证）
                      </p>
                    )}
                    {r.rawBundle &&
                      Object.entries(r.rawBundle).map(([path, content]) => (
                        <details key={path} className="mt-2">
                          <summary className="cursor-pointer font-mono text-[11.5px] text-muted hover:text-fg">
                            附属文件:{path}
                          </summary>
                          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-code px-3 py-2 font-mono text-[11.5px] text-fg">
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
        </div>
      )}

      <AiReviewLog auth={auth} reloadKey={reload} />
      <RevokeBox auth={auth} />
    </div>
  );
}

/**
 * AI 审批记录（折叠）：AI 已自动 approve/reject 的版本（review_source='ai'）。
 * escalate 项不在此（它们仍 pending，在上方待审队列以「AI 意见」呈现）。admin 覆盖权:
 * 误批可用下方 kill-switch 下架；escalate 天然进人审队列。默认折叠,展开时才拉取。
 */
function AiReviewLog({ auth, reloadKey }: { auth: AuthSession; reloadKey: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MarketplaceAiReview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .adminMarketplaceAiReviews(auth)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setErr((e as Error).message || "加载 AI 审批记录失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth, open, reloadKey]);

  return (
    <div className="m-4 mt-2 rounded-xl border border-border bg-surface p-3.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-fg outline-none"
      >
        <ChevronRight
          size={15}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Sparkles size={15} className="text-accent" />
        AI 审批记录
        <span className="ml-1 text-[11.5px] font-normal text-faint">
          （AI 自动批准/拒绝的版本；转人工的项见上方待审队列）
        </span>
      </button>
      {open && (
        <div className="mt-3">
          {err && (
            <Alert tone="danger">{err}</Alert>
          )}
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-[12.5px] text-faint">
              <Spinner /> 加载中…
            </div>
          ) : !rows || rows.length === 0 ? (
            <p className="py-2 text-[12.5px] text-faint">暂无 AI 自动审批记录。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li
                  key={r.versionId}
                  className="rounded-lg border border-border bg-elevated px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-fg">{r.name}</span>
                    {r.kind === "agent" && <Badge tone="accent">智能体</Badge>}
                    <Badge tone="neutral">v{r.version}</Badge>
                    <Badge tone={r.status === "approved" ? "success" : "danger"}>
                      {r.status === "approved" ? "已批准" : "已拒绝"}
                    </Badge>
                    {r.reviewedAt && (
                      <span className="ml-auto text-[11px] text-faint">{fmtDateTime(r.reviewedAt)}</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-muted">{r.slug}</p>
                  {r.aiNote && (
                    <p className="mt-1 text-[12px] leading-relaxed text-fg">
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
    </div>
  );
}

function fmtDateTime(t: string): string {
  try {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return t;
    return d.toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return t;
  }
}

/**
 * 下架(kill-switch)：撤销一个已上架条目,下次容器同步自动从所有用户移除。
 * slug 输入带已上架目录 datalist 提示(技能+智能体),确认框回显条目名防误下架。
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
      api.searchMarketplace(auth, "", "skill", 50).catch(() => ({ results: [] as MarketplaceCard[] })),
      api.searchMarketplace(auth, "", "agent", 50).catch(() => ({ results: [] as MarketplaceCard[] })),
    ]).then(([s, a]) => {
      if (alive) setCatalog([...s.results, ...a.results]);
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
      title: `下架「${known ? `${known.name}（${target}）` : target}」?`,
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
      setMsg({ tone: "danger", text: (e as Error).message || "下架失败" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-4 mt-2 rounded-xl border border-danger/30 bg-danger-soft/40 p-3.5">
      {confirmDialogEl}
      <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-danger">
        <ShieldX size={15} /> 下架已上架条目（kill-switch）
      </div>
      {msg && (
        <div className="mb-2">
          <Alert tone={msg.tone}>{msg.text}</Alert>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug"
          list="revoke-slug-options"
        />
        <datalist id="revoke-slug-options">
          {catalog.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}（{c.kind === "agent" ? "智能体" : "技能"}）
            </option>
          ))}
        </datalist>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="下架原因（可选）"
        />
        <Button variant="danger" onClick={revoke} disabled={busy || !slug.trim()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : "下架"}
        </Button>
      </div>
    </div>
  );
}
