import { ChevronRight, FileText, Loader2, Pencil, Search, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, MarketplaceMyAgent, SkillDetail, SkillSummary } from "../../lib/types";
import { cn } from "../../lib/utils";
import { AgentScopeSummary } from "../AgentScopePicker";
import { Alert, Badge, Button, EmptyState, Input, PanelHeader, Spinner, useConfirm } from "../ui";
import { ratesFromPublicModel, type ModelRates } from "../../lib/skillRunCost";
import { SKILL_RUN_MODEL, SkillEvalSection, SkillTrainSection } from "./SkillOptPanel";
import { SkillEditor } from "./SkillEditor";

/**
 * 技能库：列出用户可用技能（经容器代理 /api/skills），展开看正文（/api/skills/:name），
 * 可写的可删除（DELETE /api/skills/:name）。内置/只读技能仅查看。
 */
export function SkillsPanel({ auth }: { auth: AuthSession }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("");
  const [rates, setRates] = useState<ModelRates | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();

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
      } catch (e) {
        setErr(apiErrorMessage(e, "删除失败"));
      }
    },
    [auth, confirmDialog],
  );

  // 过滤：名称/描述/标签（本地即时过滤，不发请求）。
  const q = filter.trim().toLowerCase();
  const visible = (skills ?? []).filter(
    (sk) =>
      !q ||
      sk.name.toLowerCase().includes(q) ||
      (sk.description ?? "").toLowerCase().includes(q) ||
      (sk.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );

  return (
    <div className="flex flex-col">
      {confirmDialogEl}
      <PanelHeader
        title={skills && skills.length > 0 ? `技能（${skills.length}）` : "技能"}
        hint="完成复杂任务后智能体会把流程沉淀成可复用技能；也可从市场安装。"
      />
      {err && (
        <div className="px-5 pb-2">
          <Alert tone="danger" className="text-[12.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1">{err}</span>
              {skills === null && (
                <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>
                  重试
                </Button>
              )}
            </div>
          </Alert>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-faint">
          <Spinner /> 加载技能…
        </div>
      ) : err && skills === null ? null : !skills || skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="还没有技能"
          hint="在对话里让智能体「把这个流程存成技能」即可自动沉淀，或从市场安装。"
        />
      ) : (
        <>
          {skills.length > 5 && (
            <div className="px-4 pb-2.5">
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
                />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="按名称 / 描述 / 标签过滤…"
                  className="pl-8"
                />
              </div>
            </div>
          )}
          {visible.length === 0 ? (
            <p className="px-5 py-8 text-center text-[12.5px] text-faint">没有匹配的技能，换个关键词试试。</p>
          ) : (
            <ul className="flex flex-col gap-1.5 px-4 pb-4">
              {visible.map((sk) => (
                <SkillRow
                  key={sk.name}
                  auth={auth}
                  skill={sk}
                  agents={agents}
                  rates={rates}
                  onDelete={() => remove(sk.name)}
                  onChanged={() => setReload((n) => n + 1)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

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
  const [section, setSection] = useState<"body" | "evals" | "train">("body");
  const [editorOpen, setEditorOpen] = useState(false);
  // P3「未配评测」提示点:自建可写技能有无评测用例(null=未探测;只读/市场技能不探测)。
  // 列表数据不含 evals 信息,故在技能行展开时按需轻量探一次(非列表级批量请求)。
  const [hasEvals, setHasEvals] = useState<boolean | null>(null);
  const showEvalHint = skill.writable === true && skill.layer !== "hub";

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    if (!detail && !loading) {
      setLoading(true);
      setErr(null);
      api
        .getSkill(auth, skill.name)
        .then(setDetail)
        .catch((e) => setErr(apiErrorMessage(e, "加载技能正文失败")))
        .finally(() => setLoading(false));
    }
    // 自建可写技能:展开时探一次「有无评测用例」,决定是否给「未配评测」提示点。
    // 保留旧值不闪烁;拉取失败静默(hasEvals 维持原状 → 不误报徽章)。
    if (showEvalHint) {
      api
        .getSkillEvals(auth, skill.name)
        .then((r) => setHasEvals((r.evals?.cases?.length ?? 0) > 0))
        .catch(() => {});
    }
  }, [open, detail, loading, auth, skill.name, showEvalHint]);

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={14} />
        </span>
        <button type="button" onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium text-fg">{skill.name}</span>
            {skill.description && (
              <span className="block truncate text-[12px] text-muted">{skill.description}</span>
            )}
          </span>
          <ChevronRight
            size={15}
            className={cn("ml-auto shrink-0 text-faint transition-transform", open && "rotate-90")}
          />
        </button>
        <button
          onClick={() => setEditorOpen(true)}
          aria-label={`编辑 ${skill.name}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil size={14} />
        </button>
        {skill.writable && (
          <button
            onClick={onDelete}
            aria-label={`删除 ${skill.name}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint outline-none hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <SkillEditor
        auth={auth}
        skillName={skill.name}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onChanged={() => {
          // 编辑器改动后使已加载的正文缓存失效(下次展开重新拉)。
          setDetail(null);
          onChanged();
        }}
      />
      <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
        <Badge tone={skill.layer === "hub" ? "neutral" : "accent"}>
          {skill.layer === "hub" ? "市场" : "自建"}
        </Badge>
        {skill.writable === false && <Badge tone="neutral">只读</Badge>}
        <span className="inline-flex items-center gap-1 text-[12px] text-muted">
          适用：<AgentScopeSummary agentIds={skill.agentIds} agents={agents} />
        </span>
        {(skill.tags ?? []).slice(0, 6).map((t) => (
          <Badge key={t} tone="neutral">
            {t}
          </Badge>
        ))}
      </div>
      {open && (
        <div className="border-t border-border px-3.5 py-3">
          <div className="mb-2.5 flex gap-1">
            {(
              [
                { id: "body", label: "正文" },
                { id: "evals", label: "评测" },
                ...(skill.writable ? [{ id: "train", label: "训练优化" }] : []),
              ] as Array<{ id: "body" | "evals" | "train"; label: string }>
            ).map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setSection(t.id)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  section === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {t.label}
              </button>
            ))}
            {/* 自建可写技能无评测用例 → 克制的「未配评测」提示点(faint 色,点击跳评测页签)。
                只读/市场技能不显示;已配评测(hasEvals=true)或未探测(null)时不显示。 */}
            {showEvalHint && hasEvals === false && section !== "evals" && (
              <button
                type="button"
                onClick={() => setSection("evals")}
                title="这个技能还没有评测用例,点击去「评测」配置"
                className="ml-auto inline-flex items-center gap-1 self-center rounded-full px-2 py-0.5 text-[11px] text-faint outline-none transition-colors hover:bg-hover hover:text-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                未配评测
              </button>
            )}
          </div>
          {section === "evals" ? (
            <SkillEvalSection auth={auth} skillName={skill.name} rates={rates} />
          ) : section === "train" ? (
            <SkillTrainSection auth={auth} skillName={skill.name} rates={rates} />
          ) : loading ? (
            <div className="flex items-center gap-2 text-[12.5px] text-faint">
              <Loader2 size={14} className="animate-spin" /> 加载正文…
            </div>
          ) : err ? (
            <span className="text-[12.5px] text-danger">{err}</span>
          ) : (
            <div className="flex flex-col gap-2">
              {detail?.files && detail.files.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-faint">{detail.files.length} 个文件</span>
                  {detail.files.map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 rounded-md bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted"
                    >
                      <FileText size={11} /> {f}
                    </span>
                  ))}
                </div>
              )}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
                {detail?.body || "（无正文）"}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
