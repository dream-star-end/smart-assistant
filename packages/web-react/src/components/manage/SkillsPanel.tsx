import {
  ChevronRight,
  Eye,
  FileText,
  FlaskConical,
  Lock,
  Pencil,
  PanelsTopLeft,
  SearchX,
  Sparkles,
  Store,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, MarketplaceMyAgent, SkillDetail, SkillSummary } from "../../lib/types";
import { cn } from "../../lib/utils";
import { AgentScopeSummary } from "../AgentScopePicker";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  ListSkeleton,
  PanelHeader,
  Skeleton,
  Toolbar,
  useConfirm,
  useToast,
} from "../ui";
import { ratesFromPublicModel, type ModelRates } from "../../lib/skillRunCost";
import { SKILL_RUN_MODEL } from "./SkillOptPanel";
import { SkillEditor, type WorkbenchTab } from "./SkillEditor";
import { ProjectSkillOverlay } from "./ProjectSkillOverlay";

/**
 * 技能库：列出用户可用技能（经容器代理 /api/skills），展开看正文摘要（/api/skills/:name），
 * 可写的可删除（DELETE /api/skills/:name）。内置/只读技能仅查看。
 *
 * ── 2026-07-26 呈现层改造 ─────────────────────────────────────────────────
 * 1. 列表回归「扫读 + 筛选」:评测 / 训练优化两条重量级流程已迁进技能工作台
 *    (SkillEditor),行手风琴只保留「正文前 20 行 + 在工作台中打开」。
 *    这一改同时消灭了评测工具条撑破面板、三层嵌套滚动、长流程无进度三个症状。
 * 2. 来源(自建 / 市场安装)从"徽章汤里的一枚 pill"提升为**分组 + 左侧图标 + 标题行芯片**
 *    三重可辨;「只读」不再占一枚同形状 Badge,改为标题行的锁形图标。
 * 3. 只读技能的行尾图标由铅笔改眼睛(点了改不了字 = 点了没有预期反应)。
 * 4. 加载态换骨架屏、空态给可点出口、删除失败走 Toast(不再有一条陈旧错误挂到面板重开)。
 */
export function SkillsPanel({
  auth,
  onOpenMarketplace,
}: {
  auth: AuthSession;
  /** 市场入口(外层持有)。缺省时不渲染相关 CTA —— 与 ConnectorsTab 同约定。 */
  onOpenMarketplace?: () => void;
}) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("");
  const [rates, setRates] = useState<ModelRates | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();

  // 训练/评测锁定模型的公开费率(成本估算与实报的数据源;拿不到就不给估算数字)。
  useEffect(() => {
    let alive = true;
    api
      .getPublicModels(auth)
      .then((ms) => alive && setRates(ratesFromPublicModel(ms.find((m) => m.id === SKILL_RUN_MODEL))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([api.listSkills(auth), api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[])])
      .then(([s, a]) => {
        // 纵深防御：平台内置技能绝不展示。后端容器已 includePlatform:false 不返回平台技能；
        // 这里再过滤一道，万一后端回归也不会漏到 UI。
        if (alive) {
          setSkills(s.filter((sk) => sk.source !== "platform"));
          setAgents(a.length ? a : [{ id: "main", slug: "main", name: "全能助手", description: "", installed: true, isDefault: true }]);
        }
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载技能失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const remove = useCallback(
    async (name: string) => {
      if (!(await confirmDialog({ title: `删除技能「${name}」?`, confirmText: "删除", danger: true }))) return;
      try {
        await api.deleteSkill(auth, name);
        setReload((n) => n + 1);
        // 行随之消失 = 离开了发起操作的上下文 → 成功/失败都走 Toast,
        // 顶层 Alert 只留给「整表加载失败」(否则一条删除失败会一直挂到面板重开)。
        toast(`已删除技能「${name}」`, "success");
      } catch (e) {
        toast(apiErrorMessage(e, "删除失败"), "error");
      }
    },
    [auth, confirmDialog, toast],
  );

  // 过滤：名称/描述/标签（本地即时过滤，不发请求）。
  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (skills ?? []).filter(
        (sk) =>
          !q ||
          sk.name.toLowerCase().includes(q) ||
          (sk.description ?? "").toLowerCase().includes(q) ||
          (sk.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      ),
    [skills, q],
  );

  // 来源分组:自建在前、市场安装在后。两组都非空时才出组头(单一来源不制造无谓层级)。
  const mine = visible.filter((sk) => sk.layer !== "hub");
  const hub = visible.filter((sk) => sk.layer === "hub");
  const grouped = mine.length > 0 && hub.length > 0;

  const total = skills?.length ?? 0;
  const title = q && total > 0 ? `技能（${visible.length}/${total}）` : total > 0 ? `技能（${total}）` : "技能";

  const renderRow = (sk: SkillSummary) => (
    <SkillRow
      key={sk.name}
      auth={auth}
      skill={sk}
      agents={agents}
      rates={rates}
      onDelete={() => remove(sk.name)}
      onChanged={() => setReload((n) => n + 1)}
    />
  );

  return (
    <div className="flex flex-col">
      {confirmDialogEl}
      <PanelHeader
        title={title}
        hint="完成复杂任务后智能体会把流程沉淀成可复用技能；也可从市场安装。"
        action={
          onOpenMarketplace ? (
            <Button size="sm" variant="secondary" onClick={onOpenMarketplace}>
              <Store size={14} /> 去市场
            </Button>
          ) : undefined
        }
      />
      <ProjectSkillOverlay auth={auth} />
      {/* 顶层 Alert 只承载「整表加载失败」。单行操作的失败走 Toast / 行内。 */}
      {err && (
        <div className="px-4 pb-2">
          <Alert
            tone="danger"
            density="compact"
            action={
              skills === null ? (
                <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                  重试
                </Button>
              ) : undefined
            }
          >
            {err}
          </Alert>
        </div>
      )}
      {loading ? (
        <div className="px-4 pb-4">
          <ListSkeleton rows={4} />
        </div>
      ) : err && skills === null ? null : !skills || skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="还没有技能"
          hint="在对话里让智能体「把这个流程存成技能」即可自动沉淀，或从市场安装现成的。"
          action={
            onOpenMarketplace ? (
              <Button variant="primary" size="sm" onClick={onOpenMarketplace}>
                <Store size={14} /> 去市场安装技能
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* 搜索框常驻:原先以 skills.length>5 为条件渲染,装一个/删一个就凭空出现或消失,
              整个列表随之上下位移约 50px。 */}
          <Toolbar
            search={filter}
            onSearchChange={setFilter}
            searchPlaceholder="按名称 / 描述 / 标签过滤…"
            debounceMs={120}
          />
          {visible.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="没有匹配的技能"
              hint={`没有名称、描述或标签包含「${filter.trim()}」的技能。`}
              action={
                <Button variant="secondary" size="sm" onClick={() => setFilter("")}>
                  清除筛选
                </Button>
              }
            />
          ) : grouped ? (
            <div className="flex flex-col gap-3 px-4 pb-4 pt-3">
              <section className="flex flex-col gap-1.5">
                <h4 className="px-1 text-caption font-medium text-muted">自建（{mine.length}）</h4>
                <ul className="flex flex-col gap-1.5">{mine.map(renderRow)}</ul>
              </section>
              <section className="flex flex-col gap-1.5">
                <h4 className="px-1 text-caption font-medium text-muted">市场安装（{hub.length}）</h4>
                <ul className="flex flex-col gap-1.5">{hub.map(renderRow)}</ul>
              </section>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5 px-4 pb-4 pt-3">{visible.map(renderRow)}</ul>
          )}
        </>
      )}
    </div>
  );
}

/** 行内正文预览只给前 N 行 —— 深度阅读/编辑一律去工作台。 */
const PREVIEW_LINES = 20;

function SkillRow({
  auth,
  skill,
  agents,
  rates,
  onDelete,
  onChanged,
}: {
  auth: AuthSession;
  skill: SkillSummary;
  agents: MarketplaceMyAgent[];
  rates: ModelRates | null;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<WorkbenchTab>("body");
  // P3「未配评测」提示点:自建可写技能有无评测用例(null=未探测;只读/市场技能不探测)。
  // 列表数据不含 evals 信息,故在技能行展开时按需轻量探一次(非列表级批量请求)。
  const [hasEvals, setHasEvals] = useState<boolean | null>(null);
  const showEvalHint = skill.writable === true && skill.layer !== "hub";
  const isHub = skill.layer === "hub";
  const uid = useId();
  const panelId = `${uid}-skill-panel`;

  const loadDetail = useCallback(() => {
    setLoading(true);
    setErr(null);
    api
      .getSkill(auth, skill.name)
      .then(setDetail)
      .catch((e) => setErr(apiErrorMessage(e, "加载技能正文失败")))
      .finally(() => setLoading(false));
  }, [auth, skill.name]);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    if (!detail && !loading) loadDetail();
    // 自建可写技能:展开时探一次「有无评测用例」,决定是否给「未配评测」提示。
    // 保留旧值不闪烁;拉取失败静默(hasEvals 维持原状 → 不误报徽章)。
    if (showEvalHint) {
      api
        .getSkillEvals(auth, skill.name)
        .then((r) => setHasEvals((r.evals?.cases?.length ?? 0) > 0))
        .catch(() => {});
    }
  }, [open, detail, loading, loadDetail, auth, skill.name, showEvalHint]);

  const openWorkbench = (t: WorkbenchTab) => {
    setEditorTab(t);
    setEditorOpen(true);
  };

  const bodyLines = (detail?.body ?? "").split("\n");
  const preview = bodyLines.slice(0, PREVIEW_LINES).join("\n");
  const tags = skill.tags ?? [];

  return (
    <li>
      <Card className="overflow-hidden">
        <div className="flex items-start gap-2.5 px-3.5 py-3">
          {/* 来源在图标层就可辨:自建=极光星芒 / 市场=店铺 */}
          <span
            className={cn(
              "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
              isHub ? "bg-hover text-muted" : "bg-accent-soft text-accent",
            )}
          >
            {isHub ? <Store size={14} /> : <Sparkles size={14} />}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            // 面板未展开时不落 aria-controls —— 指向不存在的节点在读屏上是静默失败。
            aria-controls={open ? panelId : undefined}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-section font-medium text-fg">{skill.name}</span>
                <Badge tone={isHub ? "neutral" : "accent"} size="sm">
                  {isHub ? "市场" : "自建"}
                </Badge>
                {skill.writable === false && (
                  <span
                    className="flex shrink-0 items-center text-faint"
                    title="市场安装 / 平台内置的技能不可编辑"
                  >
                    <Lock size={12} role="img" aria-label="只读" />
                  </span>
                )}
              </span>
              {skill.description && (
                <span className="mt-0.5 block truncate text-meta text-muted">{skill.description}</span>
              )}
            </span>
            <ChevronRight
              size={15}
              className={cn("mt-0.5 shrink-0 text-faint transition-transform", open && "rotate-90")}
            />
          </button>
          {/* 只读技能点「编辑」一个字都改不了 —— 图标与可访问名按 writable 分叉。
              触控靶(≥44px)与焦点环由 IconButton 原语内建,这里不再手写补丁。 */}
          <IconButton
            variant="muted"
            size="sm"
            shape="square"
            aria-label={`${skill.writable ? "编辑" : "查看"} ${skill.name}`}
            onClick={() => openWorkbench("body")}
          >
            {skill.writable ? <Pencil size={14} /> : <Eye size={14} />}
          </IconButton>
          {skill.writable && (
            <IconButton
              variant="danger"
              size="sm"
              shape="square"
              aria-label={`删除 ${skill.name}`}
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
        <SkillEditor
          auth={auth}
          skillName={skill.name}
          open={editorOpen}
          initialTab={editorTab}
          rates={rates}
          onClose={() => setEditorOpen(false)}
          onChanged={() => {
            // 工作台改动后使已加载的正文缓存失效(下次展开重新拉),并刷新列表。
            setDetail(null);
            setHasEvals(null);
            onChanged();
          }}
        />
        <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-2.5">
          <span className="inline-flex items-center gap-1 text-meta text-muted">
            适用：<AgentScopeSummary agentIds={skill.agentIds} agents={agents} />
          </span>
          {tags.slice(0, 3).map((t) => (
            <Badge key={t} tone="neutral" size="sm">
              {t}
            </Badge>
          ))}
          {tags.length > 3 && (
            <Badge tone="neutral" size="sm" title={tags.slice(3).join("、")}>
              +{tags.length - 3}
            </Badge>
          )}
        </div>
        {open && (
          <div id={panelId} className="border-t border-border px-3.5 py-3">
            {loading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-24 rounded-full" />
                <Skeleton className="h-40 rounded-md" />
              </div>
            ) : err ? (
              <Alert
                tone="danger"
                density="compact"
                action={
                  <Button size="sm" variant="secondary" onClick={loadDetail}>
                    重试
                  </Button>
                }
              >
                {err}
              </Alert>
            ) : (
              <div className="flex flex-col gap-2">
                {detail?.files && detail.files.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-meta text-muted">
                      <FileText size={12} /> {detail.files.length} 个文件
                    </span>
                    {detail.files.slice(0, 4).map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 font-mono text-caption text-muted"
                      >
                        {f}
                      </span>
                    ))}
                    {detail.files.length > 4 && (
                      <span className="text-caption text-muted">+{detail.files.length - 4}</span>
                    )}
                  </div>
                )}
                <pre className="whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-meta leading-relaxed text-fg">
                  {preview || "（无正文）"}
                </pre>
                {bodyLines.length > PREVIEW_LINES && (
                  <p className="text-caption text-muted">
                    仅显示前 {PREVIEW_LINES} 行,共 {bodyLines.length} 行 —— 完整正文在工作台里编辑。
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => openWorkbench("body")}>
                    <PanelsTopLeft size={13} /> 在工作台中打开
                  </Button>
                  {/* 自建可写技能无评测用例 → 克制的「未配评测」入口(点击直落工作台评测页签)。
                      只读/市场技能不显示;已配评测(true)或未探测(null)时不显示。 */}
                  {showEvalHint && hasEvals === false && (
                    <Button size="sm" variant="ghost" onClick={() => openWorkbench("evals")}>
                      <FlaskConical size={13} /> 未配评测,去配置
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}
