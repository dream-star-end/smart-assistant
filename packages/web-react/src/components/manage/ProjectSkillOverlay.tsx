import { ChevronRight, FileText } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useProjectScope } from "../../hooks/useProjectScope";
import { api, apiErrorMessage } from "../../lib/api";
import { isWorkScope } from "../../lib/projectScope";
import { taskboardApi } from "../../lib/taskboard";
import type { AuthSession, MarketplaceMyAgent, SkillSummary } from "../../lib/types";
import { cn } from "../../lib/utils";
import { agentScopeLabels } from "../AgentScopePicker";
import { Alert, Badge, Button, EmptyState, ListSkeleton, Switch, useToast } from "../ui";
import { isSecretSkill, skillDisplayTitle } from "./skillDisplay";

/**
 * 项目专属技能：工作项目作用域下，为该项目单独启用一组技能（整份清单一次保存）。
 *
 * ── 2026-09 审计改造（M-06）────────────────────────────────────────────────
 * 1. 非工作作用域**不渲染**：作用域提示已由壳的 ProjectScopeSelect 承担，改造前那句孤零零的
 *    灰字夹在 PanelHeader 与搜索框之间，读起来像第二段 hint。
 * 2. 默认**折叠成一行摘要**（名称 + 已启用数 + 展开）：它是技能 Tab 在工作项目下的第一屏内容，
 *    展开时曾把搜索框与技能列表下推约 250px。
 * 3. 勾选控件换 Switch + `<label htmlFor>`：原生方框复选框无可访问名、点文字不切换、命中区 ~13px。
 * 4. 每行显示列表同款展示名（描述首行），slug 降为 caption；「覆盖」这类实现词不再出现。
 * 5. 脏态：与服务端快照比对，没改动时「保存」禁用；保存失败留在块内 Alert，不再常驻一条说明。
 * 6. 密钥类技能不再写死 slug，按 isSecretSkill 规则判定（口径见 skillDisplay.ts）。
 */
export function ProjectSkillOverlay({
  auth,
  agents,
}: {
  auth: AuthSession;
  /** id→名称映射（SkillsPanel 已拉取）；缺省时适用范围退化为只显示数量。 */
  agents?: MarketplaceMyAgent[];
}) {
  const { scope } = useProjectScope();
  const toast = useToast();
  const workId = scope.workProject?.id ?? "";
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  /** 服务端最近一次确认过的清单：脏态判定基准。 */
  const [baseline, setBaseline] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const uid = useId();

  useEffect(() => {
    void reloadKey;
    if (!workId) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    void Promise.all([
      api.listSkills(auth).catch(() => [] as SkillSummary[]),
      taskboardApi.getProjectContext(auth, workId),
    ])
      .then(([list, ctx]) => {
        if (cancelled) return;
        setSkills(list.filter((s) => s.layer === "shared" || s.writable));
        const overlay = Array.isArray(ctx.skillOverlay) ? (ctx.skillOverlay as string[]) : [];
        setSelected(overlay);
        setBaseline(overlay);
        setVersion(typeof ctx.version === "number" ? ctx.version : 0);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(apiErrorMessage(e, "加载项目技能失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [auth, workId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const dirty = useMemo(() => {
    if (selected.length !== baseline.length) return true;
    const base = new Set(baseline);
    return selected.some((n) => !base.has(n));
  }, [selected, baseline]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await taskboardApi.putProjectContext(auth, workId, {
        expectedVersion: version,
        skillNames: selected,
      });
      setVersion(res.context.version);
      setBaseline(selected);
      toast("已保存项目技能", "success");
    } catch (e) {
      // 失败留在发起它的容器里（改造前是一条常驻说明预先解释"可能会失败"）。
      setSaveErr(
        apiErrorMessage(e, "保存失败：这个项目的设置刚被别处修改过，请重新读取后再保存"),
      );
    } finally {
      setSaving(false);
    }
  }, [auth, workId, version, selected, dirty, saving, toast]);

  if (!isWorkScope(scope) || !workId) return null;

  const enabledCount = selected.filter((n) => skills.some((s) => s.name === n && !isSecretSkill(s))).length;
  const summaryCount = loading ? null : enabledCount;

  return (
    <section
      className="border-t border-border px-4 py-2.5"
      data-testid="project-skill-overlay"
      aria-label="项目专属技能"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          // 折叠区只在展开时挂载:收起态不能留一个指向空气的 IDREF(t-762 manage#2;同 SkillsPanel 写法)。
          aria-controls={open ? `${uid}-body` : undefined}
          data-testid="project-skill-overlay-toggle"
          className="-ml-3 gap-1 font-medium"
        >
          <ChevronRight size={14} aria-hidden="true" className={cn("transition-transform", open && "rotate-90")} />
          项目专属技能
          {summaryCount !== null && (
            <Badge tone={summaryCount > 0 ? "accent" : "neutral"} size="sm">
              已启用 {summaryCount}
            </Badge>
          )}
        </Button>
        {open && (
          <Button size="sm" className="ml-auto" loading={saving} disabled={!dirty || loading} onClick={() => void save()}>
            保存
          </Button>
        )}
      </div>
      {open && (
        <div id={`${uid}-body`} className="mt-1 flex flex-col gap-2">
          <p className="text-caption text-muted">
            只对当前项目生效；与全局设置不一致时，以项目内为准。持有账号凭据的密钥类技能不能按项目启用。
          </p>
          {saveErr && (
            <Alert
              tone="danger"
              density="compact"
              onDismiss={() => setSaveErr(null)}
              action={
                <Button size="sm" variant="secondary" onClick={reload}>
                  重新读取
                </Button>
              }
            >
              {saveErr}
            </Alert>
          )}
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
          ) : skills.length === 0 ? (
            <EmptyState icon={FileText} title="没有可启用的技能" hint="先在上方技能列表里创建或从市场安装。" />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {skills.map((s) => {
                const blocked = isSecretSkill(s);
                const on = selected.includes(s.name) && !blocked;
                const id = `${uid}-${s.name}`;
                const { title, caption } = skillDisplayTitle(s);
                const scopeText = s.agentIds?.length
                  ? agents
                    ? `适用 ${agentScopeLabels(s.agentIds, agents).join("、")}`
                    : `已限定 ${s.agentIds.length} 个智能体`
                  : null;
                return (
                  <li key={s.name} className="flex items-center gap-3 py-2">
                    <Switch
                      id={id}
                      data-testid={`project-skill-${s.name}`}
                      checked={on}
                      disabled={blocked}
                      onCheckedChange={(checked) =>
                        setSelected((cur) => (checked ? [...cur, s.name] : cur.filter((n) => n !== s.name)))
                      }
                    />
                    <label htmlFor={id} className={cn("min-w-0 flex-1", blocked ? "cursor-not-allowed" : "cursor-pointer")}>
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className={cn("truncate text-body", blocked ? "text-faint" : "text-fg")}>{title}</span>
                        {blocked && (
                          <Badge tone="neutral" size="sm">
                            密钥类，不可用于项目
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-faint">
                        {caption && <span className="truncate font-mono">{caption}</span>}
                        {scopeText && <span>{scopeText}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
