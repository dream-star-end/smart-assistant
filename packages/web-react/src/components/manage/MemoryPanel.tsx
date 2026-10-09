import { BarChart3, Bot, Brain, Check, ChevronRight, MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import { useProjectScope } from "../../hooks/useProjectScope";
import { isWorkScope } from "../../lib/projectScope";
import { taskboardApi, type ProjectMemoryItem } from "../../lib/taskboard";
import type {
  AuthSession,
  AutoDreamLastReport,
  AutoDreamMemoryChange,
  AutoDreamReportResponse,
  MemoryFileMeta,
  MemoryIndexResponse,
  MemoryUsageDashboard,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { AgentProjectPreview } from "./AgentProjectPreview";
import { IdentityManual, useIdentityManualAuthority } from "./IdentityManual";
import { ProjectAssetsManagePanel } from "./ProjectAssetsManagePanel";
import {
  Alert,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  InlineSelect,
  Input,
  ListGroup,
  ListRow,
  ListSkeleton,
  MetaLine,
  Modal,
  PanelHeader,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";

/** 二级分段的 id 前缀：Tabs 按它派生 tab/panel 的 id，面板节点用它接 aria 关联。 */
const TAB_ID_BASE = "memory-section";

/**
 * 记忆中心（memdir 范式）。两块权威语义:
 *  - **核心记忆**（memory,per-agent）:每条记忆 = 一个 frontmatter 文件 + MEMORY.md 纯索引。
 *  - **用户画像**（user,用户级共享）:去 § 化的单文档纯 markdown,单文本编辑 + 乐观锁 409
 *    (画像与所选智能体无关,不随切换器重载)。
 *
 * ── 2026-07-26 呈现层改造 ────────────────────────────────────────────────
 * 1. **文件心智收起来**:memdir 是存储实现,不是产品概念。新建/编辑一律走「名称 / 召回描述 /
 *    类型」表单,frontmatter 与 `.md` 后缀由前端拼装;原始 md 收进编辑器里的「编辑源码」开关,
 *    只给需要它的高级用户。文案层不再出现 frontmatter / MEMORY.md / .md 这类仓库词汇。
 * 2. **两块异构记忆用二级 Tabs 分开**:核心记忆按智能体、用户画像全局共享 —— 它们此前无分隔地
 *    堆在同一滚动流里,顶部的智能体切换器在视觉上统辖了它并不控制的画像。切换器现在只在
 *    「核心记忆」段渲染,结构本身就说清了作用域。
 * 3. **加载失败不渲染编辑器**:正文加载失败时 baseline.version 为空,旧实现仍渲染可编辑
 *    Textarea,用户敲几个字保存就会以无 If-Match 的写把服务端真实记忆整体覆盖(纯 UI 造成的
 *    数据丢失路径)。现在加载失败只给「重试」出口,且 save 入口对空 version 硬拦。
 *    **核心记忆与用户画像必须同门禁**:两块记忆都是"读—改—写"的整体覆盖式写入,门禁只装一边
 *    等于没装。区别只在第二道防线的判据 —— 核心记忆的文件必然已存在(从列表点进来的),空
 *    version 只可能是没读到,可以硬拦;用户画像是**可以不存在**的单文档,首次创建与旧后端都会
 *    合法地给出空 version,所以判据必须是「这次 GET 成功过」(loaded)而不是「有 version」。
 */
export function MemoryPanel({
  auth,
  agentId,
  agents,
}: {
  auth: AuthSession;
  /** 初始选中（当前对话 agent）。 */
  agentId: string;
  agents: { id: string; name: string }[];
}) {
  const [selected, setSelected] = useState(agentId);
  const [tab, setTab] = useState<"core" | "project" | "profile" | "usage">("core");
  const { scope } = useProjectScope();
  const manualAuthority = useIdentityManualAuthority(auth);
  // This is a management resource selector, NOT a chat/delegate execution picker.
  // Keep explicitly registered manuals reachable when their canonical install is unavailable.
  const resources = [...agents];
  for (const { profile, readiness } of manualAuthority.projection?.profiles ?? []) {
    if (!resources.some(a => a.id === profile.canonicalAgentId)) {
      resources.push({ id: profile.canonicalAgentId, name: `${profile.canonicalAgentId}（${readiness === "unavailable" ? "仅管理手册" : "本实例手册"}）` });
    }
  }
  // 选中项必须在可选列表内（agent 刚被卸载时回落到列表首项/传入项）。
  const effective = resources.some((a) => a.id === selected) ? selected : agentId;
  // 项目记忆与用户画像都不按智能体分,切换器在这两段里没有作用域可控。
  const showPicker = resources.length > 1 && tab !== "profile" && tab !== "project";

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="记忆"
        hint="这些内容会作为智能体的长期记忆，在每次对话中生效。"
        action={
          // 智能体选择器是「作用范围」同一语法的行内值(图标 + 名称 + ⌄),不是灰色下拉框;
          // 窄屏时 PanelHeader 把它 portal 进壳体的上下文行右侧。
          showPicker ? (
            <InlineSelect
              icon={Bot}
              aria-label="选择智能体"
              value={effective}
              onValueChange={setSelected}
              options={resources.map((a) => ({ value: a.id, label: a.name }))}
            />
          ) : undefined
        }
      />
      {/* 二级页签:安静表面下是一条带发丝底线的文字页签,底线只在内容列内(不再通栏)。 */}
      <div className="min-w-0 px-4">
        <Tabs
          aria-label="记忆分区"
          idBase={TAB_ID_BASE}
          layout="scroll"
          className="max-w-full"
          value={tab}
          onValueChange={(v) =>
            setTab(
              v === "profile"
                ? "profile"
                : v === "usage"
                  ? "usage"
                  : v === "project"
                    ? "project"
                    : "core",
            )
          }
          items={[
            { value: "core", label: "核心记忆" },
            { value: "project", label: "项目记忆" },
            { value: "profile", label: "用户画像" },
            { value: "usage", label: "用量" },
          ]}
        />
      </div>
      <div
        role="tabpanel"
        id={`${TAB_ID_BASE}-panel-${tab}`}
        aria-labelledby={`${TAB_ID_BASE}-tab-${tab}`}
      >
        {tab === "core" ? (
          <>
            <CoreMemorySection key={`core:${effective}`} auth={auth} agentId={effective} />
            {/* 「本实例运行手册」是少数人用的高级能力：放在核心记忆正文之后，不再压在二级页签之上。 */}
            <IdentityManual
              key={`manual:${auth.snapshot().epoch}:${effective}`}
              auth={auth}
              agentId={effective}
              authority={manualAuthority}
            />
          </>
        ) : tab === "project" ? (
          <>
            <ProjectMemorySection key="project" auth={auth} />
            {/* 项目资产与「智能体会看到什么」都是项目维度的信息，跟项目记忆放同一页签；
                改造前它们追加在整个 MemoryPanel 之后、不随页签切换，定高壳里要滚过整张
                核心记忆列表才看得到。 */}
            {isWorkScope(scope) && (
              <>
                <ProjectAssetsManagePanel auth={auth} />
                <AgentProjectPreview auth={auth} agentId={effective} />
              </>
            )}
          </>
        ) : tab === "profile" ? (
          // 画像共享,用初始 agentId(稳定)做路由参数,与切换器无关。
          <UserProfileSection key="shared:user" auth={auth} agentId={agentId} />
        ) : (
          <MemoryUsageSection key={`usage:${effective}`} auth={auth} agentId={effective} />
        )}
      </div>
    </div>
  );
}

const OPERATION_LABELS: Record<string, string> = {
  index_injected: "索引注入",
  core_search: "核心检索",
  core_read: "正文读取",
  core_write: "新增核心记忆",
  core_update: "更新核心记忆",
  core_delete: "删除核心记忆",
  profile_write: "更新用户画像",
  session_search: "历史会话召回",
  archival_add: "归档新增",
  archival_search: "归档检索",
  archival_delete: "归档删除",
  auto_add: "自动记忆新增",
  auto_skip: "自动记忆跳过",
  auto_refuse: "自动记忆拒绝",
};

/**
 * 项目记忆。智能体写入即生效（台账在创建时自动晋升），所以这里只有一份"生效中"列表 +
 * 废弃出口,没有审核队列。`leftover` 是自动晋升上线**之前**留下的待确认候选:它们不再有
 * 独立入口,只能在这里被消化掉,消化完这一段就永久消失。
 */
function ProjectMemorySection({ auth }: { auth: AuthSession }) {
  const toast = useToast();
  const { scope } = useProjectScope();
  const projectId = scope.workProject?.id ?? "";
  const [official, setOfficial] = useState<ProjectMemoryItem[]>([]);
  const [leftover, setLeftover] = useState<ProjectMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 读失败与空态互斥：改造前失败只闪一条 toast，随后列表落成「还没有项目记忆」——
  // toast 消失后用户看到的是一个自信的"空"，而不是"没读到"。
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 正在提交采纳 / 忽略的候选 id：对应两个按钮进忙态，防连点重复 POST。 */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirm, confirmEl] = useConfirm();

  useEffect(() => {
    void reloadKey;
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    void taskboardApi
      .listProjectMemories(auth, projectId)
      .then((res) => {
        if (cancelled) return;
        setOfficial(res.official);
        setLeftover(
          res.candidates.filter((c) => c.status === "pending" || c.status === "conflict"),
        );
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(apiErrorMessage(e, "加载项目记忆失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, projectId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const decide = useCallback(
    async (c: ProjectMemoryItem, action: "promote" | "reject") => {
      const id = c.id ?? "";
      setBusyId(id);
      try {
        if (action === "promote") await taskboardApi.promoteProjectMemory(auth, projectId, id, c.version);
        else await taskboardApi.rejectProjectMemory(auth, projectId, id, c.version);
        toast(action === "promote" ? "已采纳" : "已忽略", "success");
        reload();
      } catch (e) {
        toast(apiErrorMessage(e, action === "promote" ? "采纳失败" : "忽略失败"), "error");
      } finally {
        setBusyId(null);
      }
    },
    [auth, projectId, reload, toast],
  );

  const discard = useCallback(
    async (item: ProjectMemoryItem) => {
      const ok = await confirm({
        title: `废弃「${memoryTitle(item.slug)}」？`,
        body: "废弃后这条记忆不再注入该项目的会话。智能体之后仍可能重新整理出新的版本。",
        danger: true,
        confirmText: "确认废弃",
      });
      if (!ok) return;
      try {
        await taskboardApi.deprecateProjectMemory(auth, projectId, item.slug, item.version);
        toast("已废弃", "success");
        reload();
      } catch (e) {
        toast(apiErrorMessage(e, "废弃失败"), "error");
      }
    },
    [auth, projectId, confirm, toast, reload],
  );

  if (!isWorkScope(scope) || !projectId) {
    return (
      <div className="px-4 pt-5 text-body text-muted" data-testid="project-memory-panel">
        选择工作项目后，这里显示该项目的记忆。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 pb-6 pt-5" data-testid="project-memory-panel">
      <SectionHeading
        title="生效中"
        count={loading || loadErr ? undefined : official.length}
        hint="智能体自动整理，注入该项目的所有会话，可随时废弃。"
      />
      {loading ? (
        <ListSkeleton rows={3} />
      ) : loadErr ? (
        <Alert
          tone="danger"
          density="compact"
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        >
          {loadErr}
        </Alert>
      ) : (
        <>
          {official.length === 0 ? (
            <div className="-mx-4">
              <EmptyState
                icon={Brain}
                title="还没有项目记忆"
                hint="智能体会把值得长期保留的项目信息整理进来，之后在这里可以看到并管理。"
              />
            </div>
          ) : (
            <ListGroup aria-label="生效中的项目记忆">
              {official.map((o) => (
                // 行面只有标题(+ 状态);「废弃」收进行尾唯一一枚安静的 ⋯ 菜单,不再是行内按钮。
                <ListRow key={o.slug} className="flex items-center justify-between gap-3 py-2 pr-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium leading-5 text-fg">
                      {memoryTitle(o.slug)}
                    </div>
                    {o.tampered && (
                      <MetaLine className="mt-0.5">
                        <Badge tone="warning" size="sm">
                          文件被改动，未注入
                        </Badge>
                      </MetaLine>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        size="sm"
                        aria-label={`${memoryTitle(o.slug)} 更多操作`}
                        className="shrink-0 text-faint hover:text-fg"
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem destructive onSelect={() => void discard(o)}>
                        废弃
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ListRow>
              ))}
            </ListGroup>
          )}
          {leftover.length > 0 && (
            <>
              <SectionHeading
                as="h3"
                className="mt-5"
                title="早前留下的待确认条目"
                count={leftover.length}
                hint="这些是改为自动生效之前写下的，还没有生效。留下或忽略它们之后这一段就会消失。"
              />
              <ListGroup aria-label="待确认的项目记忆">
              {leftover.map((c) => (
                <ListRow key={c.id ?? c.file}>
                  <div className="text-[14px] font-medium leading-5 text-fg">{memoryTitle(c.slug)}</div>
                  {/* 正文压到 3 行:决策只需看个大概,整段 1200 字的 <pre> 会把一行撑成半屏。 */}
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-line break-words text-body text-muted">
                    {(c.content ?? "").slice(0, 1200)}
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <Button
                      size="sm"
                      loading={busyId === (c.id ?? "")}
                      disabled={busyId !== null}
                      onClick={() => void decide(c, "promote")}
                    >
                      采纳
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId !== null}
                      onClick={() => void decide(c, "reject")}
                    >
                      忽略
                    </Button>
                  </div>
                </ListRow>
              ))}
              </ListGroup>
            </>
          )}
        </>
      )}
      {confirmEl}
    </div>
  );
}

/**
 * 分组标题:14/600 标题 + 弱化的等宽计数 + 可选一行说明 + 右侧操作。
 * 与 ui/GroupHeading 同档位,多一行说明 —— 页签下面不再悬一句孤零零的灰字,
 * 说明归属到它描述的那一组。
 */
function SectionHeading({
  title,
  count,
  hint,
  action,
  className,
  hideHintOnMobile,
  as: Tag = "h4",
}: {
  title: string;
  count?: number;
  hint?: string;
  action?: ReactNode;
  /** 窄屏隐藏说明行(说明只是补充语境时用;上下文已由页签与分组说清)。 */
  hideHintOnMobile?: boolean;
  className?: string;
  as?: "h3" | "h4";
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-2 pb-1", className)}>
      <div className="min-w-0 flex-1 basis-40">
        <Tag className="flex items-baseline gap-2 text-[14px] font-semibold leading-5 tabular-nums text-fg">
          {title}
          {count !== undefined && <span className="text-meta font-normal text-faint">{count}</span>}
        </Tag>
        {hint && (
          <p className={cn("mt-0.5 text-meta text-muted", hideHintOnMobile && "max-md:hidden")}>{hint}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** 存储标识（`notes.md`）→ 面向用户的标题。文件后缀对用户没有含义。 */
function memoryTitle(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

function MemoryUsageSection({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const [days, setDays] = useState(30);
  const [value, setValue] = useState<MemoryUsageDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    void reloadKey;
    let alive = true;
    setLoading(true);
    setErr(null);
    loadWithColdStartRetry(() => api.getMemoryUsage(auth, agentId, days), () => alive)
      .then((result) => {
        if (alive) setValue(result);
      })
      .catch((error) => {
        if (alive) setErr(apiErrorMessage(error, "加载记忆使用情况失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, days, reloadKey]);

  const totals = value?.totals;
  const retrievals = value?.byOperation.filter((row) =>
    ["core_search", "session_search", "archival_search"].includes(row.operation),
  ) ?? [];
  const retrievalEvents = retrievals.reduce((sum, row) => sum + row.events, 0);
  const hitEvents = retrievals.reduce((sum, row) => sum + row.hits, 0);
  const hitRate = retrievalEvents > 0 ? Math.round((hitEvents / retrievalEvents) * 100) : 0;

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-5">
      <div className="flex items-start justify-between gap-3">
        <SectionHeading
          className="min-w-0 flex-1 pb-0"
          title="记忆在会话里如何被使用"
          hint="按记忆被检索、写入和注入的真实记录统计。"
          hideHintOnMobile
        />
        {/* 时间范围是视图内的行内值,不是一只灰色下拉框。 */}
        <InlineSelect
          aria-label="统计时间范围"
          value={String(days)}
          onValueChange={(next) => setDays(Number(next) || 30)}
          options={[
            { value: "7", label: "近 7 天" },
            { value: "30", label: "近 30 天" },
            { value: "90", label: "近 90 天" },
          ]}
        />
      </div>

      {/* 读失败只给重试出口，不与「还没有可统计的记忆操作」并排 —— 后者读起来像权威结论。 */}
      {err && (
        <Alert
          tone="danger"
          density="compact"
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        >
          {err}
        </Alert>
      )}
      {loading ? (
        <ListSkeleton rows={4} />
      ) : err ? null : !value || !totals || totals.events === 0 ? (
        <div className="-mx-4">
          <EmptyState
            icon={BarChart3}
            title="还没有可统计的记忆操作"
            hint="后续检索、写入和索引注入会自动出现在这里。"
          />
        </div>
      ) : (
        <>
          {totals.freshnessGaps > 0 && (
            // 警告是一行带圆点的彩色文字,不是一块着色的框。
            <p className="flex items-start gap-2 text-body text-warning">
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning" />
              发现 {totals.freshnessGaps} 次“询问当前状态但仅使用历史记忆、未见实时证据”的影子风险。
            </p>
          )}

          {/* 四个指标是一条分格的统计带(一个容器 + 发丝分隔),不是四张下沉小卡。 */}
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border lg:grid-cols-4">
            {[
              ["使用会话", totals.sessions],
              ["记忆操作", totals.events],
              ["检索命中率", `${hitRate}%`],
              ["新鲜度风险", totals.freshnessGaps],
            ].map(([label, metric]) => (
              <div key={String(label)} className="flex flex-col gap-1 bg-surface px-4 py-3">
                <dt className="text-meta text-faint">{label}</dt>
                <dd className="text-[20px] font-semibold leading-7 tabular-nums tracking-[-0.01em] text-fg">
                  {metric}
                </dd>
              </div>
            ))}
          </dl>

          <section aria-label="按操作">
            <SectionHeading title="按操作" count={value.byOperation.length} />
            <ListGroup>
              {value.byOperation.map((row) => (
                <ListRow
                  key={`${row.operation}:${row.memoryType}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-4"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium leading-5 text-fg">
                      {OPERATION_LABELS[row.operation] ?? row.operation}
                    </div>
                    <MetaLine className="mt-0.5">
                      <span>{row.sessions} 个会话</span>
                      <span>p50 {row.p50Ms}ms</span>
                      <span>p95 {row.p95Ms}ms</span>
                    </MetaLine>
                  </div>
                  <div className="text-right text-body tabular-nums text-fg">{row.events} 次</div>
                </ListRow>
              ))}
            </ListGroup>
          </section>

          <section aria-label="最近会话">
            <SectionHeading title="最近会话" />
            <ListGroup>
              {value.recentSessions.slice(0, 20).map((row) => (
                <ListRow key={row.sessionKey}>
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate text-[14px] font-medium leading-5 text-fg">{row.title}</div>
                    <TimeAgo value={row.lastAt} className="shrink-0 text-meta tabular-nums text-faint" />
                  </div>
                  <MetaLine className="mt-0.5">
                    <span>{row.events} 次操作</span>
                    <span>{row.searches} 次检索</span>
                    <span>{row.writes} 次写入</span>
                    {row.freshnessGaps > 0 && <span className="text-warning">{row.freshnessGaps} 次新鲜度风险</span>}
                  </MetaLine>
                </ListRow>
              ))}
            </ListGroup>
          </section>
        </>
      )}
    </div>
  );
}

// ── 核心记忆（文件列表） ─────────────────────────────────────────────────────

/** frontmatter type → 徽标语义（未知 type 原样展示,中性色）。 */
const TYPE_META: Record<string, { label: string; tone: "info" | "warning" | "accent" | "neutral" }> = {
  user: { label: "用户偏好", tone: "info" },
  feedback: { label: "反馈", tone: "warning" },
  project: { label: "项目", tone: "accent" },
  reference: { label: "参考", tone: "neutral" },
};

/** 分组与芯片的展示顺序（按用户心智由近及远排,不按字母）。 */
const TYPE_ORDER = ["user", "project", "feedback", "reference"] as const;

/** 记忆文件名规则（与后端 MEMORY_FILE_RE 一致,防路径穿越）。仅在「高级·自定义文件名」用。 */
const MEMORY_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;

/** 列表超过这个条数才出现搜索与分组 —— 少量记忆时保持轻量。 */
const LIST_DENSE_THRESHOLD = 6;

// ── frontmatter ⇄ 表单字段（UI 侧唯一转换权威） ──────────────────────────────
//
// 用户永远只看到「名称 / 召回描述 / 类型 / 内容」四个字段;它们与磁盘上的 YAML 前置块之间
// 的翻译只在这里发生。刻意保留未知键(extra):智能体或后续版本写进来的字段不能因为用户在
// UI 里改了个标题就被静默抹掉。

type MemoryFront = { name: string; description: string; type: string; extra: string[] };

const EMPTY_FRONT: MemoryFront = { name: "", description: "", type: "project", extra: [] };

/** YAML 标量去引号（只处理我们自己会写出的两种形式）。 */
function unquoteScalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t.endsWith(q)) {
      const inner = t.slice(1, -1);
      return q === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
    }
  }
  return t;
}

/** 需要引号才安全的标量（首尾空白 / YAML 指示符开头 / 含 `: ` 或 ` #`）一律加双引号。 */
function quoteScalar(v: string): string {
  if (v === "") return '""';
  if (/^\s|\s$/.test(v) || /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) || /:\s|\s#/.test(v)) {
    return `"${v.replace(/([\\"])/g, "\\$1")}"`;
  }
  return v;
}

/**
 * 拆出前置块与正文。没有合法前置块时 front=null（正文即全文,不擅自造一个头）。
 * 正文只吃掉序列化时插入的那一个空行，用户自己在正文开头敲的换行必须原样保留
 * —— 否则受控 Textarea 会出现"按了回车什么都没发生"。
 */
function parseMemoryDoc(raw: string): { front: MemoryFront | null; body: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { front: null, body: raw };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return { front: null, body: raw };

  const front: MemoryFront = { name: "", description: "", type: "", extra: [] };
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m && (m[1] === "name" || m[1] === "description" || m[1] === "type")) {
      front[m[1]] = unquoteScalar(m[2]);
    } else if (line.trim()) {
      front.extra.push(line);
    }
  }
  const bodyLines = lines.slice(close + 1);
  if (bodyLines[0] === "") bodyLines.shift();
  return { front, body: bodyLines.join("\n") };
}

/** 表单字段 → 完整 md（前置块 + 空行 + 正文）。 */
function serializeMemoryDoc(front: MemoryFront, body: string): string {
  return [
    "---",
    `name: ${quoteScalar(front.name)}`,
    `description: ${quoteScalar(front.description)}`,
    `type: ${quoteScalar(front.type || "project")}`,
    ...front.extra,
    "---",
    "",
    body,
  ].join("\n");
}

/** 记忆名称 → ASCII 文件名词干。取不出可用字符（纯中文名很常见）时返回空串,由调用方兜底。 */
function slugifyMemoryName(name: string): string {
  const slug = name
    // NFKD \u628a \u00e9 \u62c6\u6210 e + \u7ec4\u5408\u91cd\u97f3,\u518d\u6574\u7c7b\u5220\u6389 Mark(\p{M}) \u2014\u2014 \u7528 Unicode \u7c7b\u522b\u800c\u4e0d\u662f
    // \u0300-\u036f \u7801\u70b9\u533a\u95f4:\u540e\u8005\u4f1a\u628a"\u57fa\u5b57\u7b26 + \u7ec4\u5408\u5b57\u7b26"\u4ece\u4e2d\u95f4\u5207\u5f00(\u5b57\u7b26\u7c7b\u4e0d\u80fd\u5339\u914d\u7ec4\u5408\u5e8f\u5217)\u3002
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return MEMORY_FILE_RE.test(`${slug}.md`) ? slug : "";
}

/** 词干 → 未占用的文件名（撞名加 -2 / -3…）。词干为空时用时间戳兜底,保证永远拿得到合法名。 */
function uniqueMemoryFile(stem: string, existing: string[]): string {
  const base = stem || `memory-${Date.now()}`;
  let candidate = `${base}.md`;
  for (let n = 2; existing.includes(candidate); n += 1) candidate = `${base}-${n}.md`;
  return candidate;
}

// 首次打开管理中心时，按需容器可能刚好还在冷启/滚动升级。桥接请求本身会等待约 10 秒，
// 但生产实测容器可能在首个 503 后约 7 秒才 ready；固定 3s + 7s 的两次重试覆盖该窗口。
// Retry-After 只允许把等待拉长（最多 30s），不能把这个已验证的安全下限压短。
const COLD_START_RETRY_DELAYS_MS = [3_000, 7_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

async function loadWithColdStartRetry<T>(
  load: () => Promise<T>,
  isActive: () => boolean,
  /** 进入重试即回调一次：让 UI 能解释这段最长二十秒的等待,而不是干晾着一个转圈。 */
  onColdStart?: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      const fallbackMs = COLD_START_RETRY_DELAYS_MS[attempt];
      if (
        fallbackMs === undefined ||
        !(error instanceof ApiError) ||
        (error.status !== 502 && error.status !== 503)
      ) {
        throw error;
      }
      const retryAfterMs = Number.isFinite(error.retryAfterSec)
        ? Math.min(Math.max(0, error.retryAfterSec! * 1_000), MAX_RETRY_AFTER_MS)
        : 0;
      if (isActive()) onColdStart?.();
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(fallbackMs, retryAfterMs)));
      if (!isActive()) throw new DOMException("aborted", "AbortError");
    }
  }
}

/** 按 type 分组 + 组内按修改时间倒序。未知 type 归入「其他」。 */
function groupByType(files: MemoryFileMeta[]) {
  const buckets = new Map<string, MemoryFileMeta[]>();
  for (const f of files) {
    const key = TYPE_META[f.type] ? f.type : "other";
    const arr = buckets.get(key);
    if (arr) arr.push(f);
    else buckets.set(key, [f]);
  }
  return [...TYPE_ORDER, "other"]
    .filter((k) => buckets.has(k))
    .map((k) => ({
      key: k,
      label: TYPE_META[k]?.label ?? "其他",
      items: [...(buckets.get(k) ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs),
    }));
}

function CoreMemorySection({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const [index, setIndex] = useState<MemoryIndexResponse | null>(null);
  const [dream, setDream] = useState<AutoDreamReportResponse | null>(null);
  const [dreamLoading, setDreamLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [coldStart, setColdStart] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryFileMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const toast = useToast();

  useEffect(() => {
    void reloadKey;
    let alive = true;
    setLoading(true);
    setColdStart(false);
    setErr(null);
    loadWithColdStartRetry(
      () => api.getMemoryIndex(auth, agentId),
      () => alive,
      () => setColdStart(true),
    )
      .then((d) => {
        if (alive) setIndex(d);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载记忆失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, reloadKey]);

  // 梦境报告是附加可感知结果：旧容器滚动升级或临时失败时不阻断核心记忆本身。
  useEffect(() => {
    void reloadKey;
    let alive = true;
    setDreamLoading(true);
    loadWithColdStartRetry(() => api.getAutoDreamReport(auth, agentId), () => alive)
      .then((d) => {
        if (alive) setDream(d);
      })
      .catch(() => {
        if (alive) setDream(null);
      })
      .finally(() => {
        if (alive) setDreamLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, reloadKey]);

  const files = index?.files ?? [];
  const indexText = (index?.text ?? "").trim();
  const q = query.trim().toLowerCase();
  const filtered = q
    ? files.filter((f) =>
        `${f.name} ${f.description} ${TYPE_META[f.type]?.label ?? f.type}`.toLowerCase().includes(q),
      )
    : files;
  const dense = files.length > LIST_DENSE_THRESHOLD;
  const groups = dense ? groupByType(filtered) : [{ key: "all", label: "", items: filtered }];
  // 整表加载失败时不并排渲染空列表 —— "报错 + 暂无核心记忆"会让人以为记忆被清空了。
  const failedCold = Boolean(err) && !index;

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-5">
      {err && (
        <Alert
          tone="danger"
          density="compact"
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        >
          {err}
        </Alert>
      )}

      {/* 梦境卡只在「有报告」或「正在整理」时出现 —— 没有报告时不渲染一张"还没有整理过"的卡,
          空记忆因此只剩一个空态(第 4 轮 §7)。占位只在列表已经出来、梦境还在路上时给:
          列表还在加载时它自己的骨架已经说明"在加载",再叠一块骨架只会多一次跳动;
          空记忆时占位会落在空态上方,读起来像第二个空态。 */}
      {dreamLoading ? (
        !loading && files.length > 0 ? (
          <Skeleton data-testid="dream-placeholder" className="h-[88px] rounded-[10px]" />
        ) : null
      ) : hasDreamCard(dream) ? (
        <AutoDreamReportCard value={dream} files={files} onOpenMemory={setEditing} />
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-3">
          {coldStart && (
            <Alert tone="info" density="compact">
              正在唤醒你的智能体，首次打开大约需要 10 秒。
            </Alert>
          )}
          <ListSkeleton rows={3} />
        </div>
      ) : failedCold ? null : files.length === 0 ? (
        <div className="-mx-4">
          <EmptyState
            icon={Brain}
            title="还没有核心记忆"
            hint="智能体会在对话中自动记下值得长期保留的信息；你也可以现在手动补充一条。"
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={14} /> 新建记忆
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* 分组标题 = 条数 + 一句作用域说明 + 新建;说明不再单独悬在页签下面。 */}
          <SectionHeading
            className="pb-0"
            title={q ? `${filtered.length} / ${files.length} 条记忆` : `${files.length} 条记忆`}
            hint="该智能体自己的观察与经验，按智能体分别保存。"
            hideHintOnMobile
            action={
              // 窄屏只写「新建」(+ 图标已说明动作),可访问名仍是「新建记忆」。
              <Button variant="ghost" size="sm" className="gap-1 px-2.5" onClick={() => setCreating(true)}>
                <Plus size={15} aria-hidden="true" />
                <span>
                  新建<span className="max-md:sr-only">记忆</span>
                </span>
              </Button>
            }
          />

          {dense && (
            <div className="relative">
              <Search
                size={15}
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              {/* 安静的搜索框:无边框的淡填充圆角条,悬停加深一档,聚焦才出描边。
                  字号沿用 Input 的 text-base(16px,iOS 不放大);触屏高度 40px。 */}
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索记忆"
                aria-label="搜索核心记忆"
                className="h-9 rounded-[10px] border-transparent bg-hover pl-9 transition-colors hover:bg-active focus:bg-surface max-md:h-10 [@media(hover:none)]:min-h-10"
                autoComplete="off"
              />
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="-mx-4">
              <EmptyState
                icon={Search}
                title="没有匹配的记忆"
                hint="换个关键词，或清除搜索看看全部记忆。"
                action={
                  <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                    清除搜索
                  </Button>
                }
              />
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key} className={cn("flex flex-col", g.label && "pt-2")}>
                {g.label && (
                  <p className="pb-2 text-meta font-medium text-muted">
                    {g.label}
                    <span className="ml-2 font-normal tabular-nums text-faint">{g.items.length}</span>
                  </p>
                )}
                <ListGroup>
                  {g.items.map((f) => (
                    <MemoryFileCard
                      key={f.file}
                      file={f}
                      // 已按类型分组时,组标题就是类型 —— 行面的元信息不再重复它。
                      showType={!g.label}
                      onOpen={() => setEditing(f)}
                    />
                  ))}
                </ListGroup>
              </div>
            ))
          )}

          {indexText && (
            <Disclosure
              label="智能体看到的记忆索引（只读）"
              srLabel="记忆索引原文"
              text={indexText}
            />
          )}
        </div>
      )}

      {editing && (
        <MemoryFileEditor
          auth={auth}
          agentId={agentId}
          file={editing}
          onReload={reload}
          onClose={() => setEditing(null)}
          onDeleted={() => {
            setEditing(null);
            toast("记忆已删除", "success");
          }}
        />
      )}
      {creating && (
        <NewMemoryFileDialog
          auth={auth}
          agentId={agentId}
          existing={files.map((f) => f.file)}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
            toast("记忆已创建", "success");
          }}
        />
      )}
    </div>
  );
}

/** 折叠的只读原文块（索引 / 冲突正文）。触控靶与焦点环由 Button 原语兜底。 */
function Disclosure({
  label,
  srLabel,
  text,
}: {
  label: string;
  /** 展开后 <pre> 的无障碍名（它是可聚焦滚动区域）。 */
  srLabel: string;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-3 gap-1 font-normal text-muted"
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={cn("transition-transform", open && "rotate-90")}
        />
        {label}
      </Button>
      {open && (
        // 可滚动区域必须能被键盘聚焦(WCAG 2.1.1),否则超出 max-h 的内容对键盘用户等于不存在;
        // <section aria-label> 是这类"命名的滚动区"的标准载体,tabIndex 落在它身上而非 <pre>。
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 规则只认交互角色,不认"可滚动区需可聚焦"这条 WCAG 要求
          tabIndex={0}
          aria-label={srLabel}
          className="mt-1.5 max-h-52 overflow-auto rounded-lg bg-code outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-caption leading-relaxed text-fg">
            {text}
          </pre>
        </section>
      )}
    </div>
  );
}

/** 变化动词:安静表面下是定宽的弱化文字列(不再是三种颜色的药丸),标题列因此纵向对齐。 */
const DREAM_ACTION_META: Record<AutoDreamMemoryChange["action"], { label: string }> = {
  created: { label: "新增" },
  updated: { label: "更新" },
  deleted: { label: "清理" },
};

/** 梦境卡的唯一出现条件:非「全面优化」模式,且有一份报告或正在整理。 */
function hasDreamCard(dream: AutoDreamReportResponse | null): dream is AutoDreamReportResponse {
  return Boolean(dream && dream.mode !== "optimizer_v2" && (dream.lastReport || dream.status === "running"));
}

function AutoDreamReportCard({
  value,
  files,
  onOpenMemory,
}: {
  value: AutoDreamReportResponse;
  files: MemoryFileMeta[];
  onOpenMemory: (file: MemoryFileMeta) => void;
}) {
  const report = value.lastReport;
  const running = value.status === "running";
  const changes = report ? [...report.created, ...report.updated, ...report.deleted] : [];
  const total = changes.length;

  return (
    // 渐变 hero 样式只保留在「全面优化」Tab —— 这里是整理**回执**,与那张待确认建议卡
    // 长得一模一样只会让用户以为是同一个东西的两个入口。
    // 第 3 轮:与记忆列表同一种分组容器,没有图标方块;变化清单是容器内的发丝线列表。
    <section
      aria-label="Auto-Dream 梦境报告"
      aria-busy={running || undefined}
      className="overflow-hidden rounded-[10px] border border-border bg-surface"
    >
      <div className="px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-5 text-fg">
            <span className="truncate">Auto‑Dream 梦境报告</span>
            {running && <Spinner size={13} className="shrink-0 text-muted" />}
          </h4>
          {running ? (
            <span className="shrink-0 text-meta text-muted">正在整理近期对话</span>
          ) : report ? (
            <TimeAgo value={report.finishedAt} className="shrink-0 text-meta tabular-nums text-faint" />
          ) : null}
        </div>
        {running ? (
          <p className="mt-1 text-body text-muted">
            正在提炼值得长期保留的信息。完成后会在这里显示变化，并发送一封站内梦境报告。
          </p>
        ) : report ? (
          <DreamReportResult report={report} total={total} />
        ) : null}
        {(report && !running) || (!running && value.pendingSessions > 0) ? (
          // 两条元信息在窄屏会折行:分隔点自己画、窄屏隐藏,避免第二行以「·」开头。
          <p className="mt-2 flex flex-wrap gap-x-1.5 gap-y-0.5 text-meta tabular-nums text-faint max-sm:flex-col">
            {report && !running && <span>已参考 {report.sessionsReviewed} 个近期会话</span>}
            {report && !running && value.pendingSessions > 0 && (
              <span aria-hidden="true" className="max-sm:hidden">
                ·
              </span>
            )}
            {!running && value.pendingSessions > 0 && (
              <span>
                下一次整理已积累 {value.pendingSessions >= 101 ? "至少 101" : value.pendingSessions} 个新会话
              </span>
            )}
          </p>
        ) : null}
      </div>

      {!running && changes.length > 0 && (
        <ul className="oc-list border-t border-border">
          {changes.map((change, index) => {
            const meta =
              change.action === "deleted"
                ? undefined
                : files.find((file) => file.file === change.file);
            const action = DREAM_ACTION_META[change.action];
            const title = meta?.name?.trim() || change.file.replace(/\.md$/i, "");
            const content = (
              <>
                <span className="w-8 shrink-0 text-meta text-faint">{action.label}</span>
                <span className="min-w-0 flex-1 truncate text-body text-fg">{title}</span>
                {meta && <ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />}
              </>
            );
            return (
              <li key={`${change.action}:${change.file}:${index}`} className="oc-list-row">
                {meta ? (
                  <button
                    type="button"
                    onClick={() => onOpenMemory(meta)}
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex min-h-11 items-center gap-3 px-4 py-2.5">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DreamReportResult({ report, total }: { report: AutoDreamLastReport; total: number }) {
  if (report.status === "failed") {
    const outcome = report.summary === "整理被中断，无法确认记忆是否发生变化，请查看记忆列表。"
      ? report.summary
      : "本次整理未完成，记忆没有改动。";
    return (
      <p className="mt-1 flex items-center gap-2 text-body text-warning">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
        {outcome}
      </p>
    );
  }
  return (
    <>
      <p className="mt-1 text-body text-fg">
        {total === 0
          ? "已完成检查，没有发现值得长期保存的新信息。"
          : `已新增 ${report.created.length} 条、更新 ${report.updated.length} 条、清理 ${report.deleted.length} 条记忆。`}
      </p>
      {report.summary?.trim() && (
        <p className="mt-1 line-clamp-2 max-w-[68ch] text-body text-muted">{report.summary}</p>
      )}
    </>
  );
}

function MemoryFileCard({
  file,
  showType = true,
  onOpen,
}: {
  file: MemoryFileMeta;
  showType?: boolean;
  onOpen: () => void;
}) {
  const typeMeta = TYPE_META[file.type] ?? { label: file.type || "记忆", tone: "neutral" as const };
  const title = file.name?.trim() || file.file.replace(/\.md$/i, "");
  return (
    // 分组容器里的一行(不是一张卡):整行可点,悬停给极淡底,右侧弱化的 › 提示可进入。
    <ListRow className="p-0">
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium leading-5 text-fg">{title}</span>
          {file.description?.trim() && (
            // 不能再加 `block`:它排在 line-clamp 的 display:-webkit-box 之后,会把截断整个取消
            // (线上一条记忆占半屏的根因)。line-clamp 自带 display,span 也能截断。
            <span data-testid="memory-row-description" className="mt-0.5 line-clamp-2 break-words text-body text-muted">
              {file.description}
            </span>
          )}
          {/* 文件名不再上卡面:它是存储实现,对用户没有含义(要看走编辑器的「编辑源码」)。 */}
          <MetaLine className="mt-1">
            {showType && (
              <Badge tone={typeMeta.tone} size="sm" className="text-meta text-faint">
                {typeMeta.label}
              </Badge>
            )}
            <span>
              更新于 <TimeAgo value={file.mtimeMs} className="text-meta text-faint" />
            </span>
          </MetaLine>
        </span>
        <ChevronRight
          size={15}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-faint transition-colors group-hover:text-muted"
        />
      </button>
    </ListRow>
  );
}

// ── 记忆表单字段（新建 / 编辑共用） ─────────────────────────────────────────

/**
 * 类型芯片。刻意**不**套 Field 原语:Field 的 `<label htmlFor>` 需要一个被标注的控件,
 * 而这里是一组按钮,没有单一控件可指 —— 一组相关控件的原生语义就是 fieldset/legend,
 * 标签排版沿用 Field 的档位(text-meta / font-medium / text-muted)保持一致。
 */
function TypeChips({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = TYPE_ORDER.map((t) => ({ value: t as string, label: TYPE_META[t].label }));
  const options =
    value && !TYPE_META[value] ? [...known, { value, label: value }] : known;
  return (
    <fieldset>
      <legend className="text-meta font-medium text-muted">类型</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Button
              key={o.value}
              size="sm"
              shape="pill"
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 名称 / 召回描述 / 类型 / 正文四字段。frontmatter 与 .md 后缀对用户完全不可见。 */
function MemoryDocFields({
  front,
  body,
  bodyRows,
  onFront,
  onBody,
}: {
  front: MemoryFront;
  body: string;
  bodyRows: number;
  onFront: (patch: Partial<MemoryFront>) => void;
  onBody: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="记忆名称" required>
        <Input
          value={front.name}
          onChange={(e) => onFront({ name: e.target.value })}
          placeholder="例如：常用项目栈"
          autoComplete="off"
        />
      </Field>
      <Field
        label="什么时候该想起它"
        required
        hint="智能体按这句话判断当前对话要不要调用这条记忆，写得越具体越准。"
      >
        <Input
          value={front.description}
          onChange={(e) => onFront({ description: e.target.value })}
          placeholder="例如：我常用的项目栈与部署约定"
          autoComplete="off"
        />
      </Field>
      <TypeChips value={front.type} onChange={(type) => onFront({ type })} />
      <Field label="记忆内容" required>
        <Textarea
          value={body}
          onChange={(e) => onBody(e.target.value)}
          rows={bodyRows}
          placeholder="写下希望智能体长期记住的内容…"
          className="resize-y"
        />
      </Field>
    </div>
  );
}

// ── 单文件查看/编辑（模态） ───────────────────────────────────────────────────

function MemoryFileEditor({
  auth,
  agentId,
  file,
  onReload,
  onClose,
  onDeleted,
}: {
  auth: AuthSession;
  agentId: string;
  file: MemoryFileMeta;
  /** 保存/删除后刷新外层列表(不关闭编辑器)。 */
  onReload: () => void;
  onClose: () => void;
  /** 删除成功：由外层关闭编辑器并给 toast（行消失=离开当前上下文）。 */
  onDeleted: () => void;
}) {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState<{ content: string; version: string }>({ content: "", version: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  // loadErr 与 err 必须分开:前者要**挡住编辑器**(见文件头注释的数据丢失路径),
  // 后者是保存/删除失败,应贴在编辑器内原地展示。
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 409:该文件被别处修改。持有服务端最新正文+version,由用户显式选择覆盖或载入最新。
  const [conflict, setConflict] = useState<{ content: string; version: string } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [confirm, confirmEl] = useConfirm();
  const sourceId = useId();

  // 前置块缺 type（或整份缺前置块）时回落列表元数据里的 type —— 不能因为用户在 UI 里
  // 改了个标题就把这条记忆的分类默默改掉。
  const normalizeFront = useCallback(
    (f: MemoryFront | null): MemoryFront =>
      f
        ? { ...f, type: f.type || file.type || "project" }
        : { ...EMPTY_FRONT, type: file.type || "project" },
    [file.type],
  );

  const doc = parseMemoryDoc(content);
  const front = normalizeFront(doc.front);
  const title = front.name.trim() || file.name?.trim() || file.file.replace(/\.md$/i, "");

  useEffect(() => {
    void retryKey;
    let alive = true;
    setLoading(true);
    setLoadErr(null);
    api
      .getMemoryFile(auth, agentId, file.file)
      .then((d) => {
        if (!alive) return;
        setContent(d.content);
        setBaseline({ content: d.content, version: d.version });
      })
      .catch((e) => {
        if (alive) setLoadErr(apiErrorMessage(e, "加载记忆内容失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, file.file, retryKey]);

  const dirty = content !== baseline.content;

  const setFront = useCallback(
    (patch: Partial<MemoryFront>) => {
      setContent((cur) => {
        const parsed = parseMemoryDoc(cur);
        return serializeMemoryDoc({ ...normalizeFront(parsed.front), ...patch }, parsed.body);
      });
    },
    [normalizeFront],
  );

  const setBody = useCallback(
    (next: string) => {
      setContent((cur) => {
        const parsed = parseMemoryDoc(cur);
        // 无前置块的存量文件:只改正文,不擅自给它造一个头。
        return parsed.front ? serializeMemoryDoc(normalizeFront(parsed.front), next) : next;
      });
    },
    [normalizeFront],
  );

  /**
   * 写入必须带 If-Match（version）。version 为空 = 正文没读成功过,此时任何 PUT 都是
   * 「用一个我从没读到过的内容覆盖服务端真实记忆」—— 硬拦,这是第二道防线。
   */
  const runSave = useCallback(
    async (version: string) => {
      if (!version) {
        setErr("内容尚未加载完成，请先重新加载再保存。");
        return;
      }
      setSaving(true);
      setErr(null);
      try {
        const res = await api.putMemoryFile(auth, agentId, file.file, content, version);
        if (res.ok) {
          setBaseline({ content, version: res.version });
          setConflict(null);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
          onReload();
          return;
        }
        // 版本落后:不覆盖,保留用户未保存文本,由用户显式选覆盖还是载入最新。
        setConflict(res.conflict);
      } catch (e) {
        setErr(apiErrorMessage(e, "保存失败"));
      } finally {
        setSaving(false);
      }
    },
    [auth, agentId, file.file, content, onReload],
  );

  const save = useCallback(() => void runSave(baseline.version), [runSave, baseline.version]);

  /** 以我的版本覆盖：采纳服务端最新 version 作基线,立刻用当前文本重写。 */
  const overwriteWithMine = useCallback(() => {
    const c = conflict;
    if (!c) return;
    setConflict(null);
    setBaseline((b) => ({ ...b, version: c.version }));
    void runSave(c.version);
  }, [conflict, runSave]);

  /** 放弃我的修改：把服务端最新内容载入编辑器（dirty 归零）。 */
  const loadLatest = useCallback(() => {
    const c = conflict;
    if (!c) return;
    setContent(c.content);
    setBaseline({ content: c.content, version: c.version });
    setConflict(null);
  }, [conflict]);

  const remove = useCallback(async () => {
    const ok = await confirm({
      title: `删除记忆「${title}」？`,
      body: "删除后这条记忆将不再注入智能体上下文，且无法恢复。",
      danger: true,
      confirmText: "确认删除",
    });
    if (!ok) return;
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteMemoryFile(auth, agentId, file.file);
      onReload();
      onDeleted();
    } catch (e) {
      setErr(apiErrorMessage(e, "删除失败"));
      setDeleting(false);
    }
  }, [auth, agentId, file.file, title, confirm, onReload, onDeleted]);

  /** Esc / 遮罩 / X 关闭：脏态先确认,几百字的记忆正文不能被一次误触抹掉。 */
  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirm({
      title: "放弃未保存的修改？",
      body: "这条记忆的改动尚未保存，关闭后将丢失。",
      danger: true,
      confirmText: "放弃修改",
      cancelText: "继续编辑",
    }).then((ok) => {
      if (ok) onClose();
    });
  }, [dirty, confirm, onClose]);

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => {
          if (!o) requestClose();
        }}
        title={title}
        description={front.description.trim() || undefined}
        size="lg"
        mobile="fullscreen"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={remove}
              loading={deleting}
              // 刻意**不**随 loadErr 禁用：读不到正文的记忆更需要一个清理出口,而删除是
              // 显式且带确认的操作,不属于本批要堵的"盲写覆盖"路径（那条只堵 PUT）。
              disabled={saving}
              className="text-danger hover:bg-danger-soft max-sm:mr-0 sm:mr-auto"
            >
              <Trash2 size={14} /> 删除
            </Button>
            {(dirty || saved) && (
              <span
                className={cn(
                  "self-center text-caption max-sm:text-center",
                  saved ? "text-success" : "text-warning",
                )}
              >
                {saved ? "已保存" : "有未保存的修改"}
              </span>
            )}
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!dirty || loading || deleting || Boolean(conflict) || Boolean(loadErr)}
            >
              {saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
          </>
        }
      >
        {/* 保存结果对读屏用户也要可感知（视觉上是按钮旁那行小字）。 */}
        <span className="sr-only" aria-live="polite">
          {saved ? "已保存" : ""}
        </span>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : loadErr ? (
          <Alert
            tone="danger"
            title="没能读到这条记忆的内容"
            action={
              <Button size="sm" variant="secondary" onClick={() => setRetryKey((k) => k + 1)}>
                重试
              </Button>
            }
          >
            {loadErr}（可能是智能体正在启动）。为避免覆盖服务端上的真实内容，加载成功前不能编辑。
          </Alert>
        ) : (
          <>
            {err && (
              <Alert tone="danger" density="compact" className="mb-3" onDismiss={() => setErr(null)}>
                {err}
              </Alert>
            )}
            {conflict && (
              <Alert
                tone="warning"
                density="compact"
                className="mb-3"
                title="这条记忆在你编辑期间被智能体更新了"
              >
                <p>你可以用自己的版本覆盖，或载入最新内容重新编辑。</p>
                <Disclosure
                  label="查看智能体写入的最新内容"
                  srLabel="服务端最新内容"
                  text={conflict.content}
                />
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button variant="primary" size="sm" onClick={overwriteWithMine}>
                    用我的版本覆盖
                  </Button>
                  <Button variant="secondary" size="sm" onClick={loadLatest}>
                    放弃我的修改，载入最新
                  </Button>
                </div>
              </Alert>
            )}
            {sourceMode ? (
              <>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={16}
                  spellCheck={false}
                  aria-label="记忆源码"
                  placeholder={"---\nname: …\ndescription: …\ntype: project\n---\n正文…"}
                  className="min-h-64 resize-y font-mono"
                />
                <p className="mt-1.5 text-caption text-muted">
                  源码模式直接编辑存储原文（含首部字段块）。改坏了字段块会让这条记忆失去标题与召回描述。
                </p>
              </>
            ) : (
              <MemoryDocFields
                front={front}
                body={doc.body}
                bodyRows={12}
                onFront={setFront}
                onBody={setBody}
              />
            )}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
              <label htmlFor={sourceId} className="text-caption text-muted">
                编辑源码
              </label>
              <Switch id={sourceId} checked={sourceMode} onCheckedChange={setSourceMode} />
            </div>
          </>
        )}
      </Modal>
      {confirmEl}
    </>
  );
}

// ── 新建记忆（模态） ─────────────────────────────────────────────────────────

function NewMemoryFileDialog({
  auth,
  agentId,
  existing,
  onClose,
  onCreated,
}: {
  auth: AuthSession;
  agentId: string;
  existing: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [front, setFrontState] = useState<MemoryFront>({ ...EMPTY_FRONT });
  const [body, setBody] = useState("");
  const [customFile, setCustomFile] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, confirmEl] = useConfirm();

  const setFront = useCallback(
    (patch: Partial<MemoryFront>) => setFrontState((f) => ({ ...f, ...patch })),
    [],
  );

  // 文件名默认由名称派生（用户完全不必知道它的存在）；高级里可覆写。
  const autoFile = uniqueMemoryFile(slugifyMemoryName(front.name), existing);
  const trimmedCustom = customFile.trim();
  const normalizedCustom = trimmedCustom
    ? /\.md$/i.test(trimmedCustom)
      ? trimmedCustom
      : `${trimmedCustom}.md`
    : "";
  const customInvalid = Boolean(normalizedCustom) && !MEMORY_FILE_RE.test(normalizedCustom);
  const customDuplicate = Boolean(normalizedCustom) && existing.includes(normalizedCustom);
  const fileError = customInvalid
    ? "标识需以字母或数字开头，只能含字母、数字、- 与 _"
    : customDuplicate
      ? "已存在同名记忆，请换一个"
      : null;
  const filename = normalizedCustom && !fileError ? normalizedCustom : autoFile;

  const canSubmit =
    front.name.trim().length > 0 &&
    front.description.trim().length > 0 &&
    body.trim().length > 0 &&
    !fileError &&
    !saving;
  const dirty = Boolean(front.name || front.description || body || customFile);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api.putMemoryFile(
        auth,
        agentId,
        filename,
        serializeMemoryDoc(front, body),
        undefined,
      );
      if (res.ok) {
        onCreated();
        return;
      }
      // 新建理论上不冲突(undefined version 不做校验);真撞名给友好提示。
      setErr("已存在同名记忆，请换个名称后重试。");
    } catch (e) {
      setErr(apiErrorMessage(e, "创建失败"));
    } finally {
      setSaving(false);
    }
  }, [canSubmit, auth, agentId, filename, front, body, onCreated]);

  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    void confirm({
      title: "放弃这条草稿？",
      body: "刚填的内容还没有创建，关闭后将丢失。",
      danger: true,
      confirmText: "放弃草稿",
      cancelText: "继续编辑",
    }).then((ok) => {
      if (ok) onClose();
    });
  }, [dirty, confirm, onClose]);

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => {
          if (!o) requestClose();
        }}
        title="新建记忆"
        description="写清楚它是什么、什么时候该想起它，智能体就能在合适的时机用上。"
        size="lg"
        mobile="fullscreen"
        footer={
          <>
            <Button variant="ghost" onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={submit} loading={saving} disabled={!canSubmit}>
              创建
            </Button>
          </>
        }
      >
        {err && (
          <Alert tone="danger" density="compact" className="mb-3" onDismiss={() => setErr(null)}>
            {err}
          </Alert>
        )}
        <MemoryDocFields
          front={front}
          body={body}
          bodyRows={10}
          onFront={setFront}
          onBody={setBody}
        />
        <div className="mt-4 border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="-ml-3 gap-1 font-normal text-muted"
          >
            <ChevronRight
              size={13}
              aria-hidden="true"
              className={cn("transition-transform", showAdvanced && "rotate-90")}
            />
            高级
          </Button>
          {showAdvanced && (
            <Field
              label="存储标识"
              className="mt-1.5"
              hint={`留空则自动使用 ${filename.replace(/\.md$/i, "")}。仅影响存储，不影响智能体如何理解这条记忆。`}
              error={fileError ?? undefined}
            >
              <Input
                value={customFile}
                onChange={(e) => setCustomFile(e.target.value)}
                placeholder="例如 user-preferences"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
        </div>
      </Modal>
      {confirmEl}
    </>
  );
}

// ── 用户画像（单文本编辑 + 409） ─────────────────────────────────────────────

function UserProfileSection({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const [text, setText] = useState("");
  // baseline = 最近一次已知的服务端权威态（text + 乐观锁 version），冲突后刷新到最新。
  const [baseline, setBaseline] = useState<{ text: string; version: string }>({ text: "", version: "" });
  const [limit, setLimit] = useState(0); // 字符预算（来自 GET）；0 = 不强制。
  const [loading, setLoading] = useState(true);
  /**
   * 本轮 GET 真的成功过 —— 渲染编辑器的**唯一**许可。
   *
   * 不能用 `baseline.version` 代替:画像是可以尚不存在的单文档,首次创建与不发令牌的旧后端
   * 都会合法地返回空 version(见 MemoryDocResponse.version 的注释),按 version 判会把正常的
   * "第一次写画像"一起堵死。也不能用 `!loadErr` 代替:那是 deny-list,状态机漏一个分支就重新
   * 敞开盲写口 —— 这里取 allow-list,未知状态一律不给编辑器。
   */
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 与 MemoryFileEditor 同构:loadErr 挡住编辑器(读失败=不知道服务端有什么),
  // err 是保存失败,贴在编辑器内原地展示。两者混用一个 state 就是本 P0 的根因。
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // 冲突刷新提示（info，非报错）。
  const [serverLatest, setServerLatest] = useState<string | null>(null); // 冲突后服务端最新画像(供查看)。
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    void reloadKey;
    let alive = true;
    setLoading(true);
    setLoaded(false);
    setLoadErr(null);
    setErr(null);
    setNotice(null);
    setServerLatest(null);
    api
      .getMemory(auth, agentId, "user")
      .then((d) => {
        if (!alive) return;
        const t = d.text || "";
        setText(t);
        setBaseline({ text: t, version: d.version ?? "" });
        setLimit(typeof d.limit === "number" ? d.limit : 0);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) setLoadErr(apiErrorMessage(e, "加载用户画像失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, reloadKey]);

  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const dirty = norm(text) !== norm(baseline.text);
  // 计数与超限判定用同一口径（归一换行、不 trim）：改造前正常态显示 trim 后长度、
  // 超限态切成未 trim 的 text.length，跨过限额那一刻数字会跳。
  const chars = norm(text).length;
  const overLimit = limit > 0 && chars > limit;

  const save = useCallback(async () => {
    // 第二道防线（第一道是"没 loaded 就不渲染编辑器"，所以这条从 UI 走不到）。留着是因为
    // 第一道是渲染分支、第二道是网络出口:将来谁把保存按钮挪出这个分支，盲写口不会跟着重开。
    // 判据是"读成功过"而不是"有 version":空 version 的合法首次创建必须放行,读失败必须拦死。
    if (!loaded) {
      setErr("用户画像尚未加载完成，请先重新加载再保存。");
      return;
    }
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api.putMemory(auth, agentId, "user", text, baseline.version || undefined);
      if (res.ok) {
        setBaseline({ text, version: res.version });
        setServerLatest(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        return;
      }
      // 版本冲突:刷新基线到服务端最新态(下次 PUT 带新 version 才写得进),保留用户当前编辑。
      setBaseline({ text: res.conflict.text, version: res.conflict.version });
      setServerLatest(res.conflict.text);
      setNotice("智能体在你编辑期间更新了用户画像。再次保存将以你的版本为准；也可以放弃当前修改、载入最新内容。");
    } catch (e) {
      setErr(apiErrorMessage(e, "保存失败"));
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, text, baseline.version, loaded]);

  /** 放弃我的修改：载入服务端最新画像（基线已在 409 分支刷新，dirty 随之归零）。 */
  const loadLatest = useCallback(() => {
    if (serverLatest === null) return;
    setText(serverLatest);
    setNotice(null);
    setServerLatest(null);
  }, [serverLatest]);

  return (
    <div className="flex flex-col gap-3 px-4 pb-6 pt-5">
      <SectionHeading
        className="pb-0"
        title="所有智能体共享"
        hint="关于你的背景信息，切换智能体不会改变这里。"
      />

      {notice && (
        <Alert tone="info" density="compact" onDismiss={() => setNotice(null)}>
          <p>{notice}</p>
          {serverLatest !== null && (
            <>
              <Disclosure
                label="查看智能体写入的最新画像"
                srLabel="服务端最新画像"
                text={serverLatest || "（空）"}
              />
              <div className="mt-1 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={save} loading={saving}>
                  用我的版本覆盖
                </Button>
                <Button variant="secondary" size="sm" onClick={loadLatest}>
                  放弃我的修改，载入最新
                </Button>
              </div>
            </>
          )}
        </Alert>
      )}

      {loading ? (
        <output aria-busy="true" className="block">
          <span className="sr-only">加载中…</span>
          <Skeleton className="h-32 w-full rounded-lg" />
        </output>
      ) : !loaded ? (
        // 读失败(或任何"没读成功"的状态)只给重试出口。渲染出可编辑框 = 邀请用户用一段
        // 凭空敲出来的文本整体覆盖服务端上真实存在的画像。
        <Alert
          tone="danger"
          title="没能读到你的用户画像"
          action={
            <Button size="sm" variant="secondary" onClick={reload}>
              重试
            </Button>
          }
        >
          {loadErr ?? "加载用户画像失败"}（可能是智能体正在启动）。为避免覆盖你已有的画像，加载成功前不能编辑。
        </Alert>
      ) : (
        <>
          {err && (
            <Alert tone="danger" density="compact" onDismiss={() => setErr(null)}>
              {err}
            </Alert>
          )}
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={saving}
            rows={8}
            aria-label="用户画像"
            placeholder="例如：称呼、职业背景、常用项目与偏好、沟通风格…"
            className="min-h-32 resize-y"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              loading={saving}
              disabled={!dirty || overLimit}
              title={
                overLimit ? `已超出字符预算（${chars}/${limit}），请精简后再保存` : undefined
              }
            >
              {saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
            <span className={cn("text-caption", overLimit ? "font-medium text-danger" : "text-muted")}>
              {chars}
              {limit > 0 ? `/${limit}` : ""} 字符
            </span>
            <span className="sr-only" aria-live="polite">
              {saved ? "已保存" : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
