import { ChevronRight, SearchX, Sparkles, Store } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, MarketplaceMyAgent, SkillSummary } from "../../lib/types";
import { cn } from "../../lib/utils";
import { agentScopeLabels } from "../AgentScopePicker";
import {
  Alert,
  Button,
  EmptyState,
  GroupHeading,
  ListGroup,
  ListRow,
  ListSkeleton,
  PanelHeader,
  Toolbar,
  useConfirm,
  useToast,
} from "../ui";
import { ratesFromPublicModel, type ModelRates } from "../../lib/skillRunCost";
import { SKILL_RUN_MODEL } from "./SkillOptPanel";
import { SkillEditor } from "./SkillEditor";
import { ProjectSkillOverlay } from "./ProjectSkillOverlay";
import { skillDisplayTitle } from "./skillDisplay";

/**
 * 技能库：列出用户可用技能（经容器代理 /api/skills），点行打开技能工作台；
 * 可写的可在工作台底部删除（DELETE /api/skills/:name）。内置/只读技能仅查看。
 *
 * ── 2026-07-26 呈现层改造 ─────────────────────────────────────────────────
 * 1. 列表回归「扫读 + 筛选」:评测 / 训练优化两条重量级流程已迁进技能工作台
 *    (SkillEditor),行手风琴只保留「正文前 20 行 + 在工作台中打开」。
 *    这一改同时消灭了评测工具条撑破面板、三层嵌套滚动、长流程无进度三个症状。
 * 2. 来源(自建 / 市场安装)从"徽章汤里的一枚 pill"提升为**分组 + 左侧图标 + 标题行芯片**
 *    三重可辨;「只读」不再占一枚同形状 Badge,改为标题行的锁形图标。
 * 3. 只读技能的行尾图标由铅笔改眼睛(点了改不了字 = 点了没有预期反应)。
 * 4. 加载态换骨架屏、空态给可点出口、删除失败走 Toast(不再有一条陈旧错误挂到面板重开)。
 *
 * ── OCV5-344 第 3 轮(安静表面)─────────────────────────────────────────
 * 每组技能是**一个**分组容器(ListGroup),行之间是发丝线,不再「每条一张卡 + 每行一个
 * 星芒图标方块」。
 *
 * ── OCV5-360 第 4 轮(移动端)─────────────────────────────────────────────
 * 行 = 一个点按目标(打开工作台),不再有行内 编辑 / 删除 按钮簇与手风琴预览;
 * slug 离开行面,删除进工作台底部。页头操作收成一颗「市场」小按钮(窄屏 portal 进上下文行)。
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
      .then(({ models: ms }) => alive && setRates(ratesFromPublicModel(ms.find((m) => m.id === SKILL_RUN_MODEL))))
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
    async (sk: SkillSummary): Promise<boolean> => {
      // 确认框与 toast 用列表同款展示名(描述首行);slug 只在与展示名不同的时候补在正文里,
      // 免得同一个技能在列表 / 确认框 / 工作台叫三个名字。
      const { title, caption } = skillDisplayTitle(sk);
      const ok = await confirmDialog({
        title: `删除技能「${title}」？`,
        body: caption ? `技能标识 ${caption}。删除后智能体将不再使用它，且无法恢复。` : "删除后智能体将不再使用它，且无法恢复。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return false;
      try {
        await api.deleteSkill(auth, sk.name);
        setReload((n) => n + 1);
        // 行随之消失 = 离开了发起操作的上下文 → 成功/失败都走 Toast,
        // 顶层 Alert 只留给「整表加载失败」(否则一条删除失败会一直挂到面板重开)。
        toast(`已删除技能「${title}」`, "success");
        return true;
      } catch (e) {
        toast(apiErrorMessage(e, "删除失败"), "error");
        return false;
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
  // 计数不再塞进页面标题的全角括号里:放在搜索框右侧,等宽数字、弱化色。
  const countLabel = q ? `${visible.length} / ${total}` : `${total} 个技能`;

  const renderRow = (sk: SkillSummary) => (
    <SkillRow
      key={sk.name}
      auth={auth}
      skill={sk}
      agents={agents}
      rates={rates}
      onDelete={() => remove(sk)}
      onChanged={() => setReload((n) => n + 1)}
    />
  );

  return (
    <div className="flex flex-col">
      {confirmDialogEl}
      <PanelHeader
        title="技能"
        hint="完成复杂任务后智能体会把流程沉淀成可复用技能；也可从市场安装。"
        action={
          onOpenMarketplace ? (
            <Button size="sm" variant="ghost" onClick={onOpenMarketplace} className="gap-1.5 px-2.5">
              <Store size={14} strokeWidth={1.75} aria-hidden="true" /> 市场
            </Button>
          ) : undefined
        }
      />
      <ProjectSkillOverlay auth={auth} agents={agents} />
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
            searchPlaceholder="搜索技能"
            debounceMs={120}
            sticky={false}
            // 安静表面:不画吸顶色带与底边线,搜索框与列表同一左缘。
            className="flex-nowrap border-b-0 bg-transparent px-4 pb-3 pt-0 md:pb-4"
            actions={<span className="whitespace-nowrap text-meta tabular-nums text-faint">{countLabel}</span>}
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
            <div className="flex flex-col gap-8 px-4 pb-4">
              <section>
                <GroupHeading title="自建" count={mine.length} />
                <ListGroup>{mine.map(renderRow)}</ListGroup>
              </section>
              <section>
                <GroupHeading title="市场安装" count={hub.length} />
                <ListGroup>{hub.map(renderRow)}</ListGroup>
              </section>
            </div>
          ) : (
            <div className="px-4 pb-4">
              <ListGroup>{visible.map(renderRow)}</ListGroup>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 元信息行最多露出的标签数,其余折成「+N」。 */
const META_TAGS = 2;

/** MetaLine 的同款样式(MetaLine 渲染 <div>,而行在 <button> 里只能放短语内容,故用 <span> 复刻)。 */
const META_CLASS = "oc-meta flex min-w-0 items-center gap-x-1.5 gap-y-0.5 text-meta tabular-nums text-faint";

/**
 * 技能行(OCV5-360 第 4 轮):整行就是一个点按目标 → 打开技能工作台。
 * 行面只留三层:标题(最多两行)/ 其余描述(两行截断)/ 一条 12px 元信息
 * (来源 · 只读 · 适用 · 前两个标签 +N)。slug、编辑 / 删除按钮与行内正文预览都不再上行:
 * slug 进工作台,删除是工作台「正文」页签底部的危险操作。
 */
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
  onDelete: () => Promise<boolean>;
  onChanged: () => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const descId = `${useId()}-desc`;
  const isHub = skill.layer === "hub";
  const display = skillDisplayTitle(skill);
  // 标题取描述首行;描述的其余行才作为行面的「描述」—— 不把同一句话印两遍。
  const rest = (skill.description ?? "").split(/\r?\n/).slice(1).join(" ").trim();
  const tags = skill.tags ?? [];
  const scope = agentScopeLabels(skill.agentIds, agents);
  const scopeLabel =
    scope.length === 0 ? "暂未启用" : scope.length <= 2 ? scope.join("、") : `${scope.slice(0, 2).join("、")} 等 ${scope.length} 个`;

  return (
    <ListRow data-interactive="" className="p-0 first:rounded-t-[9px] last:rounded-b-[9px]">
      <button
        type="button"
        onClick={() => setEditorOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${skill.writable ? "打开" : "查看"} ${display.title}`}
        aria-describedby={descId}
        className="flex min-h-12 w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span data-skill-title="" className="line-clamp-2 text-[14px] font-medium leading-5 text-fg">
            {display.title}
          </span>
          <span id={descId} className="contents">
          {rest && (
            <span data-skill-desc="" className="mt-0.5 line-clamp-2 text-body leading-[18px] text-muted">
              {rest}
            </span>
          )}
          <span data-skill-meta="" className={cn(META_CLASS, "mt-1 flex-nowrap overflow-hidden whitespace-nowrap")}>
            <span className="shrink-0">{isHub ? "市场" : "自建"}</span>
            {skill.writable === false && <span className="shrink-0">只读</span>}
            <span className="min-w-0 truncate">{scopeLabel}</span>
            {tags.length > 0 && (
              <span className="shrink-0">
                {tags.slice(0, META_TAGS).map((t) => `#${t}`).join(" ")}
                {tags.length > META_TAGS && ` +${tags.length - META_TAGS}`}
              </span>
            )}
          </span>
          </span>
        </span>
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />
      </button>
      <SkillEditor
        auth={auth}
        skillName={skill.name}
        displayTitle={display.title}
        open={editorOpen}
        rates={rates}
        onClose={() => setEditorOpen(false)}
        onChanged={onChanged}
        onDelete={skill.writable ? onDelete : undefined}
      />
    </ListRow>
  );
}
