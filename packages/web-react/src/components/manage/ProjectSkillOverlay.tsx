import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import { isWorkScope } from "../../lib/projectScope";
import { taskboardApi } from "../../lib/taskboard";
import type { AuthSession, MarketplaceMyAgent, SkillSummary } from "../../lib/types";
import { useProjectScope } from "../../hooks/useProjectScope";
import { FileText } from "lucide-react";
import { agentScopeLabels } from "../AgentScopePicker";
import { Alert, Button, EmptyState, ListSkeleton, useToast } from "../ui";

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
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!workId) return;
    setLoading(true);
    void Promise.all([
      api.listSkills(auth).catch(() => [] as SkillSummary[]),
      taskboardApi.getProjectContext(auth, workId),
    ])
      .then(([list, ctx]) => {
        setSkills(list.filter((s) => s.layer === "shared" || s.writable));
        const overlay = Array.isArray(ctx.skillOverlay)
          ? (ctx.skillOverlay as string[])
          : [];
        setSelected(overlay);
        setVersion(typeof ctx.version === "number" ? ctx.version : 0);
      })
      .catch((e) => toast(apiErrorMessage(e, "加载项目技能失败"), "error"))
      .finally(() => setLoading(false));
  }, [auth, workId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const excluded = useMemo(
    () => new Set(["v5-selfhost-cursor-account-pool", "v5-selfhost-cursor-key-rotation", "v5-selfhost-moonshot-k3-key-sync"]),
    [],
  );

  if (!isWorkScope(scope) || !workId) {
    return (
      <div className="px-4 py-3" data-testid="project-skill-overlay-disabled">
        <p className="text-caption text-muted">选择工作项目后，可为该项目单独启用技能，不影响其他项目。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3" data-testid="project-skill-overlay">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-section font-semibold">项目专属技能</h3>
        <Button
          size="sm"
          disabled={saving || loading}
          onClick={() => {
            setSaving(true);
            void taskboardApi
              .putProjectContext(auth, workId, { expectedVersion: version, skillNames: selected })
              .then((res) => {
                setVersion(res.context.version);
                toast("已保存项目技能", "success");
              })
              .catch((e) => toast(apiErrorMessage(e, "保存失败，项目设置可能已被更新，请重试"), "error"))
              .finally(() => setSaving(false));
          }}
        >
          保存
        </Button>
      </div>
      <p className="text-caption text-muted">这里勾选的技能只对当前项目生效；与全局设置不一致时，以项目内为准。密钥类技能已排除。</p>
      {loading ? (
        <ListSkeleton rows={4} />
      ) : skills.length === 0 ? (
        <EmptyState icon={FileText} title="没有可勾选的技能" hint="用户技能在管理中心「技能」里创建。" />
      ) : (
        <ul className="flex flex-col gap-1">
          {skills.map((s) => {
            const blocked = excluded.has(s.name);
            const on = selected.includes(s.name);
            return (
              <li key={s.name} className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  data-testid={`project-skill-${s.name}`}
                  disabled={blocked}
                  checked={on && !blocked}
                  onChange={(e) => {
                    setSelected((cur) =>
                      e.target.checked ? [...cur, s.name] : cur.filter((n) => n !== s.name),
                    );
                  }}
                />
                <span className={blocked ? "text-faint" : ""}>
                  {s.name}
                  {on ? " · 覆盖" : ""}
                  {blocked ? " · 已排除" : ""}
                  {s.agentIds?.length
                    ? agents
                      ? ` · 适用 ${agentScopeLabels(s.agentIds, agents).join("、")}`
                      : ` · 已限定 ${s.agentIds.length} 个智能体`
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Alert tone="info" className="text-caption">
        技能清单会整体保存。若提示保存失败，说明该项目的设置刚被其他地方修改过，刷新后重试即可，不会只保存一半。
      </Alert>
    </div>
  );
}
