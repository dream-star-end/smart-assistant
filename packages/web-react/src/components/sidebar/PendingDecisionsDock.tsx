/**
 * 侧栏统一「待拍板」聚合收件箱（OCV5-833 · Clarvy Atelier）。
 *
 * 按需经 React.lazy 加载，不进首屏主包：
 *   - 聚合 4 类人工审批源（turn_permission / connector_write / taskboard / browser_handoff）；
 *   - 无待拍板时返回 null，零噪音零占位；
 *   - 二元可批准项提供「批准 / 拒绝」一键操作（乐观加载态 + 409 冲突自动刷新提示）；
 *   - `requiresInteractiveAnswer`（ask_user）与 `browser_handoff` 严禁提供误导性二元批准按钮，
 *     改为展示「直达处理」直接跳至目标会话或云浏览器接管视口。
 */
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Plug,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptionalAuth } from "../../hooks/useProjectScope";
import { ApiError } from "../../lib/api/http";
import {
  PENDING_DECISION_SOURCE_LABELS,
  type PendingDecisionAction,
  type PendingDecisionItem,
  type PendingDecisionSource,
  isInteractiveOnlyDecision,
  listPendingDecisions,
  resolvePendingDecision,
} from "../../lib/api/wave4Api";
import type { AuthSession } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, IconButton, Spinner, useToast } from "../ui";
import { AtelierIcon } from "../ui/AtelierIcons";
import "./pendingDecisions.css";

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_VISIBLE_ITEMS = 12;

/** 从 taskboard 待拍板条目解析任务单 identifier（优先）或 ticketId，供直达详情抽屉使用。 */
export function resolveTaskboardTicketRef(item: PendingDecisionItem): string | null {
  if (item.source !== "taskboard") return null;
  const metaIdent =
    typeof item.metadata?.identifier === "string" ? item.metadata.identifier.trim() : "";
  if (metaIdent) return metaIdent;
  const metaTicketId =
    typeof item.metadata?.ticketId === "string" ? item.metadata.ticketId.trim() : "";
  if (metaTicketId) return metaTicketId;
  const stripped = item.sourceId.replace(/@v\d+$/, "").trim();
  return stripped || null;
}

export type PendingDecisionsDockProps = {
  auth?: AuthSession | null;
  socketVersion?: number;
  onSelectSession?: (sessionId: string) => void;
  onOpenBoard?: (ticketRef?: string) => void;
  onOpenLiveBrowser?: (opts?: { url?: string; sessionId?: string | null }) => void;
  /** 测试或外部控制轮询间隔（默认 30s；传 0 禁用定时轮询）。 */
  pollIntervalMs?: number;
  defaultCollapsed?: boolean;
};

function sourceIcon(source: PendingDecisionSource) {
  switch (source) {
    case "turn_permission":
      return <AtelierIcon name="terminal" size={12} />;
    case "connector_write":
      return <Plug size={11} aria-hidden />;
    case "taskboard":
      return <AtelierIcon name="tasks" size={12} />;
    case "browser_handoff":
      return <AtelierIcon name="sites" size={12} />;
  }
}

function riskBadge(risk: PendingDecisionItem["riskLevel"]) {
  if (risk === "critical") {
    return (
      <Badge tone="danger" size="sm" className="oc-breathe-aura">
        极高风险
      </Badge>
    );
  }
  if (risk === "high") return <Badge tone="warning" size="sm">高风险</Badge>;
  return null;
}

export function PendingDecisionsDock({
  auth: authProp,
  socketVersion,
  onSelectSession,
  onOpenBoard,
  onOpenLiveBrowser,
  pollIntervalMs = POLL_INTERVAL_MS,
  defaultCollapsed = false,
}: PendingDecisionsDockProps) {
  const ctxAuth = useOptionalAuth();
  const auth = authProp !== undefined ? authProp : ctxAuth;
  const toast = useToast();

  const [items, setItems] = useState<PendingDecisionItem[]>([]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [sourceFilter, setSourceFilter] = useState<PendingDecisionSource | "all">("all");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const lastFetchAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchItems = useCallback(
    async (opts?: { silent?: boolean; signal?: AbortSignal }) => {
      if (!auth) {
        setItems([]);
        return;
      }
      lastFetchAtRef.current = Date.now();
      if (!opts?.silent) setRefreshing(true);
      try {
        const res = await listPendingDecisions(auth, { limit: 50, signal: opts?.signal });
        if (!mountedRef.current || opts?.signal?.aborted) return;
        setItems(res.items ?? []);
      } catch {
        // 侧栏静默容错：后端未挂载或瞬时断网时不制造噪音
      } finally {
        if (mountedRef.current && !opts?.signal?.aborted && !opts?.silent) {
          setRefreshing(false);
        }
      }
    },
    [auth],
  );

  useEffect(() => {
    if (!auth) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    void fetchItems({ silent: true, signal: controller.signal });
    return () => controller.abort();
  }, [auth, fetchItems]);

  // 流式回合里 socketVersion 高频前进，节流避免频繁打接口（至少间隔 3s）。
  useEffect(() => {
    if (!auth || socketVersion === undefined) return;
    if (Date.now() - lastFetchAtRef.current < 3_000) return;
    const controller = new AbortController();
    void fetchItems({ silent: true, signal: controller.signal });
    return () => controller.abort();
  }, [auth, socketVersion, fetchItems]);

  useEffect(() => {
    if (!auth || pollIntervalMs <= 0) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void fetchItems({ silent: true });
    }, pollIntervalMs);
    return () => window.clearInterval(id);
  }, [auth, pollIntervalMs, fetchItems]);

  const countsBySource = useMemo(() => {
    const counts: Partial<Record<PendingDecisionSource, number>> = {};
    for (const item of items) {
      counts[item.source] = (counts[item.source] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const activeSources = useMemo(
    () => (Object.keys(countsBySource) as PendingDecisionSource[]),
    [countsBySource],
  );

  const effectiveFilter =
    sourceFilter !== "all" && (countsBySource[sourceFilter] ?? 0) > 0 ? sourceFilter : "all";

  const filteredItems = useMemo(
    () => (effectiveFilter === "all" ? items : items.filter((i) => i.source === effectiveFilter)),
    [items, effectiveFilter],
  );

  // 无待拍板时零噪音收起
  if (items.length === 0) return null;

  const visibleItems = showAll ? filteredItems : filteredItems.slice(0, DEFAULT_VISIBLE_ITEMS);
  const hiddenCount = filteredItems.length - visibleItems.length;

  const handleResolve = async (item: PendingDecisionItem, decision: PendingDecisionAction) => {
    if (!auth || resolvingId) return;
    setResolvingId(item.id);
    setConflictNotice(null);
    try {
      const res = await resolvePendingDecision(auth, item.id, {
        decision,
        idempotencyKey: `web-${item.id}-${decision}`,
        originChannel: "web",
      });
      if (!mountedRef.current) return;
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      const verb = decision === "approve" ? "已批准" : "已拒绝";
      toast(
        res.idempotentReplay ? `${verb}（此前已同步处理）` : `${verb}：${item.title}`,
        "success",
      );
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if (err instanceof ApiError && err.status === 409) {
        const msg = "该项决策已被其他终端处理或状态已变化，已自动刷新最新列表。";
        setConflictNotice(msg);
        toast(msg, "info");
        void fetchItems({ silent: false });
      } else {
        toast(err instanceof Error ? err.message : "提交决策失败，请稍后重试", "error");
      }
    } finally {
      if (mountedRef.current) setResolvingId(null);
    }
  };

  const handleDirectGoto = (item: PendingDecisionItem) => {
    if (item.source === "browser_handoff") {
      const url = typeof item.metadata?.url === "string" ? item.metadata.url : undefined;
      if (item.sessionId && onSelectSession) onSelectSession(item.sessionId);
      if (onOpenLiveBrowser) {
        onOpenLiveBrowser({ url, sessionId: item.sessionId });
        return;
      }
    }
    if (item.source === "taskboard" && onOpenBoard) {
      const ticketRef = resolveTaskboardTicketRef(item);
      onOpenBoard(ticketRef ?? undefined);
      return;
    }
    if (item.sessionId && onSelectSession) {
      onSelectSession(item.sessionId);
    }
  };

  return (
    <section
      aria-label="待拍板决策收件箱"
      data-testid="pending-decisions-dock"
      className="oc-pd-dock"
    >
      <div className="oc-pd-head">
        <button
          type="button"
          data-testid="pending-decisions-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
          className="oc-pd-title-btn"
        >
          <span className="oc-pd-icon" aria-hidden>
            <AtelierIcon name="shield" size={13} />
          </span>
          <span className="truncate">待拍板</span>
          <span className="oc-pd-count" data-testid="pending-decisions-count">
            {items.length}
          </span>
          <span className="ml-auto text-faint" aria-hidden>
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </span>
        </button>
        <IconButton
          size="sm"
          shape="square"
          aria-label="刷新待拍板列表"
          title="刷新待拍板"
          disabled={refreshing}
          onClick={() => void fetchItems()}
          className="oc-spring-press size-7 shrink-0 [@media(hover:none)]:size-11"
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : undefined} />
        </IconButton>
      </div>

      {!collapsed && (
        <>
          {activeSources.length > 1 && (
            <div role="group" aria-label="按来源筛选待拍板" className="oc-pd-filters">
              <button
                type="button"
                aria-pressed={effectiveFilter === "all"}
                onClick={() => setSourceFilter("all")}
                className="oc-pd-filter-pill"
              >
                全部 {items.length}
              </button>
              {activeSources.map((src) => (
                <button
                  key={src}
                  type="button"
                  aria-pressed={effectiveFilter === src}
                  onClick={() => setSourceFilter(effectiveFilter === src ? "all" : src)}
                  className="oc-pd-filter-pill"
                >
                  {sourceIcon(src)}
                  <span>{PENDING_DECISION_SOURCE_LABELS[src]}</span>
                  <span className="font-mono tabular-nums">{countsBySource[src]}</span>
                </button>
              ))}
            </div>
          )}

          {conflictNotice && (
            <div className="mt-1.5 shrink-0 px-0.5" data-testid="pending-decisions-conflict">
              <Alert tone="warning">{conflictNotice}</Alert>
            </div>
          )}

          <div className="oc-pd-list" data-testid="pending-decisions-list">
            {visibleItems.map((item) => {
              const interactiveOnly = isInteractiveOnlyDecision(item);
              const busy = resolvingId === item.id;
              const canDeny = item.allowedActions.includes("deny");
              const canGoto =
                (item.source === "taskboard" && Boolean(onOpenBoard)) ||
                (item.source === "browser_handoff" && Boolean(onOpenLiveBrowser || (item.sessionId && onSelectSession))) ||
                Boolean(item.sessionId && onSelectSession);
              const gotoLabel =
                item.source === "browser_handoff"
                  ? "直达接管"
                  : item.metadata?.requiresInteractiveAnswer === true
                    ? "直达回答"
                    : "直达处理";

              return (
                <article
                  key={item.id}
                  data-testid="pending-decision-item"
                  data-decision-id={item.id}
                  data-decision-source={item.source}
                  data-risk={item.riskLevel}
                  className={cn("oc-pd-card", item.riskLevel === "critical" && "oc-breathe-aura")}
                >
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone="neutral" size="sm" className="gap-1">
                      {sourceIcon(item.source)}
                      {PENDING_DECISION_SOURCE_LABELS[item.source]}
                    </Badge>
                    {riskBadge(item.riskLevel)}
                  </div>

                  {canGoto ? (
                    <button
                      type="button"
                      onClick={() => handleDirectGoto(item)}
                      className="oc-pd-body-btn space-y-0.5"
                      title={item.source === "taskboard" ? `打开任务详情：${item.title}` : item.title}
                    >
                      <div className="oc-pd-card-title truncate text-caption font-semibold text-fg transition-colors">
                        {item.title}
                      </div>
                      {item.summary && (
                        <p className="line-clamp-2 text-micro leading-relaxed text-muted">
                          {item.summary}
                        </p>
                      )}
                    </button>
                  ) : (
                    <div className="min-w-0 space-y-0.5">
                      <div className="truncate text-caption font-semibold text-fg" title={item.title}>
                        {item.title}
                      </div>
                      {item.summary && (
                        <p className="line-clamp-2 text-micro leading-relaxed text-muted" title={item.summary}>
                          {item.summary}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="oc-pd-actions">
                    {interactiveOnly ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="accent"
                          disabled={busy}
                          data-testid="pending-decision-goto"
                          onClick={() => handleDirectGoto(item)}
                          className="oc-spring-press h-7 flex-1 gap-1 px-2 text-caption [@media(hover:none)]:h-11 [@media(hover:none)]:min-h-11"
                        >
                          <ArrowUpRight size={12} aria-hidden />
                          {gotoLabel}
                        </Button>
                        {canDeny && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy || Boolean(resolvingId)}
                            data-testid="pending-decision-deny"
                            onClick={() => void handleResolve(item, "deny")}
                            className="oc-spring-press h-7 px-2 text-caption text-muted [@media(hover:none)]:h-11 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
                          >
                            {busy ? <Spinner size={11} /> : <X size={12} aria-hidden />}
                            拒绝
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="accent"
                          disabled={busy || Boolean(resolvingId)}
                          data-testid="pending-decision-approve"
                          onClick={() => void handleResolve(item, "approve")}
                          className="oc-spring-press h-7 flex-1 gap-1 px-2 text-caption [@media(hover:none)]:h-11 [@media(hover:none)]:min-h-11"
                        >
                          {busy ? <Spinner size={11} /> : <Check size={12} aria-hidden />}
                          批准
                        </Button>
                        {canDeny && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy || Boolean(resolvingId)}
                            data-testid="pending-decision-deny"
                            onClick={() => void handleResolve(item, "deny")}
                            className="oc-spring-press h-7 flex-1 gap-1 px-2 text-caption [@media(hover:none)]:h-11 [@media(hover:none)]:min-h-11"
                          >
                            <X size={12} aria-hidden />
                            拒绝
                          </Button>
                        )}
                        {(item.sessionId || item.source === "taskboard") && (
                          <IconButton
                            size="sm"
                            shape="square"
                            data-testid="pending-decision-open-source"
                            aria-label={`前往查看 ${item.title}`}
                            title={item.source === "taskboard" ? "查看该任务单详情" : "前往对应会话"}
                            onClick={() => handleDirectGoto(item)}
                            className="oc-spring-press size-7 shrink-0 [@media(hover:none)]:size-11"
                          >
                            <ArrowUpRight size={12} />
                          </IconButton>
                        )}
                      </>
                    )}
                  </div>
                </article>
              );
            })}

            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="oc-live-strip-more"
                data-testid="pending-decisions-show-more"
              >
                展开其余 {hiddenCount} 条待拍板
              </button>
            )}
            {showAll && filteredItems.length > DEFAULT_VISIBLE_ITEMS && (
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="oc-live-strip-more"
              >
                收起部分待拍板
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default PendingDecisionsDock;
