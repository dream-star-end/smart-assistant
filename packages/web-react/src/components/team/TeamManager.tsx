import * as Dialog from "@radix-ui/react-dialog";
import { Crown, Play, Plus, Trash2, Users, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AGENTS } from "../../lib/agents";
import { api } from "../../lib/api";
import type {
  AgentTeam,
  AgentTeamInput,
  AgentTeamMember,
  AuthSession,
  TeamRun,
  TeamRunStatus,
} from "../../lib/types";
import { Alert, Button, Spinner, Switch } from "../ui";
import { EmptyState, PanelHeader } from "../manage/parts";

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring";
const MAX_MEMBERS = 8;
const MAX_PARALLEL = 2;

function agentName(id: string): string {
  return AGENTS.find((a) => a.id === id)?.name ?? id;
}

function teamNameOf(teams: AgentTeam[] | null, teamId: string): string {
  return teams?.find((t) => t.id === teamId)?.name ?? teamId;
}

const RUN_STATUS_LABEL: Record<TeamRunStatus, string> = {
  pending: "准备中",
  running: "运行中",
  waiting_review: "等待复核",
  finalize_required: "待提交",
  finalizing: "收尾中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function runDotCls(s: TeamRunStatus): string {
  if (s === "completed") return "bg-success";
  if (s === "failed" || s === "interrupted") return "bg-danger";
  if (s === "running" || s === "pending" || s === "finalizing") return "bg-accent";
  return "bg-muted";
}

// 团队名常为中文，无法 slug；创建时给一个随机默认 id，用户可改成有意义的英文 id。
function genTeamId(): string {
  return `team-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 团队管理中心：列出 / 新建 / 编辑 / 删除智能体团队（经容器代理 /api/agent-teams*）。
 * 团队 = 一个队长 + 若干成员 + 协作策略（并发上限 / 强制复核）。运行语义在服务端强制。
 */
export function TeamManager({
  open,
  auth,
  onClose,
  onLaunch,
  onViewRun,
}: {
  open: boolean;
  auth: AuthSession | null;
  onClose: () => void;
  /** 点某团队的「发起」按钮时回调（跳到发起器）。 */
  onLaunch?: (teamId: string, teamName: string) => void;
  /** 点某历史运行时回调（查看账本）。 */
  onViewRun?: (runId: string, title: string) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">团队</Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <TeamPanel
                auth={auth}
                onLaunch={onLaunch}
                onViewRun={onViewRun}
                onClose={onClose}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TeamPanel({
  auth,
  onLaunch,
  onViewRun,
  onClose,
}: {
  auth: AuthSession;
  onLaunch?: (teamId: string, teamName: string) => void;
  onViewRun?: (runId: string, title: string) => void;
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<AgentTeam[] | null>(null);
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<AgentTeam | "new" | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([api.listTeams(auth), api.listTeamRuns(auth, 15)])
      .then(([t, r]) => {
        if (alive) {
          setTeams(t);
          setRuns(r);
        }
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const remove = useCallback(
    async (team: AgentTeam) => {
      if (!confirm(`删除团队「${team.name}」？`)) return;
      try {
        await api.deleteTeam(auth, team.id);
        refresh();
      } catch (e) {
        setErr((e as Error).message || "删除失败");
      }
    },
    [auth, refresh],
  );

  if (editing) {
    return (
      <TeamEditor
        auth={auth}
        team={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="智能体团队"
        hint="配置一个队长带若干成员协作：队长拆解目标、并行委派、按需强制复核。"
        action={
          <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
            <Plus size={14} />
            新建团队
          </Button>
        }
      />
      {err && (
        <div className="px-5 pb-3">
          <Alert>{err}</Alert>
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !teams || teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title="还没有团队"
          hint="创建一个团队，让多个智能体分工协作完成复杂任务。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5 px-3 pb-4">
          {teams.map((team) => (
            <li
              key={team.id}
              className="group flex items-center gap-3 rounded-lg border border-border px-3.5 py-3"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Users size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium text-fg">{team.name}</p>
                  {team.policy?.requireReview && (
                    <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">
                      强制复核
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-[11.5px] text-faint">
                  <Crown size={11} className="mb-0.5 mr-0.5 inline" />
                  {agentName(team.leaderAgentId)} · {team.members.length} 名成员 · 并发{" "}
                  {team.policy?.maxParallel ?? 1}
                </p>
              </div>
              {onLaunch && (
                <button
                  onClick={() => {
                    onLaunch(team.id, team.name);
                    onClose();
                  }}
                  title="发起运行"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-colors hover:bg-hover hover:text-accent focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                >
                  <Play size={15} />
                </button>
              )}
              <button
                onClick={() => setEditing(team)}
                title="编辑"
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                编辑
              </button>
              <button
                onClick={() => remove(team)}
                title="删除"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {onViewRun && runs.length > 0 && (
        <div className="mt-1 border-t border-border/60 px-3 pb-4 pt-3">
          <p className="px-1 pb-2 text-[11.5px] font-medium text-faint">最近运行</p>
          <ul className="flex flex-col gap-0.5">
            {runs.map((run) => (
              <li key={run.teamRunId}>
                <button
                  onClick={() => {
                    onViewRun(run.teamRunId, teamNameOf(teams, run.teamId));
                    onClose();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className={`size-1.5 shrink-0 rounded-full ${runDotCls(run.status)}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg">
                      {run.userGoal || "（无目标）"}
                    </span>
                    <span className="block truncate text-[11px] text-faint">
                      {teamNameOf(teams, run.teamId)} · {RUN_STATUS_LABEL[run.status]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TeamEditor({
  auth,
  team,
  onCancel,
  onSaved,
}: {
  auth: AuthSession;
  team: AgentTeam | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!team;
  const [teamId, setTeamId] = useState(team?.id ?? genTeamId());
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [leaderAgentId, setLeaderAgentId] = useState(team?.leaderAgentId ?? AGENTS[0]?.id ?? "");
  const [members, setMembers] = useState<AgentTeamMember[]>(team?.members ?? []);
  const [maxParallel, setMaxParallel] = useState(team?.policy?.maxParallel ?? 1);
  const [requireReview, setRequireReview] = useState(team?.policy?.requireReview ?? false);
  const [reviewAgentId, setReviewAgentId] = useState(team?.policy?.reviewAgentId ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addMember = () => {
    if (members.length >= MAX_MEMBERS) return;
    const pick = AGENTS.find(
      (a) => a.id !== leaderAgentId && !members.some((m) => m.agentId === a.id),
    );
    if (!pick) return;
    setMembers((ms) => [...ms, { agentId: pick.id }]);
  };
  const updateMember = (i: number, patch: Partial<AgentTeamMember>) =>
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const removeMember = (i: number) => setMembers((ms) => ms.filter((_, j) => j !== i));

  const memberOptions = (current: string) =>
    AGENTS.filter(
      (a) => a.id !== leaderAgentId && (a.id === current || !members.some((m) => m.agentId === a.id)),
    );

  const save = async () => {
    setErr(null);
    if (!name.trim()) return setErr("团队名称必填");
    if (!isEdit && !/^[a-zA-Z0-9_-]+$/.test(teamId)) {
      return setErr("团队 ID 只能含字母、数字、- 和 _");
    }
    if (members.length === 0) return setErr("至少添加一名成员");
    if (requireReview && !reviewAgentId) return setErr("开启强制复核时必须指定复核者");
    const body: AgentTeamInput = {
      // 编辑时 id 固定（后端禁止改）；新建时用用户填/生成的 id。
      id: isEdit && team ? team.id : teamId,
      name: name.trim(),
      description: description.trim() || undefined,
      leaderAgentId,
      // 透传本 UI 尚未编辑的字段（PUT 是整体替换，不透传会清空）—— Codex 审。
      leaderRole: team?.leaderRole,
      leaderPrompt: team?.leaderPrompt,
      members: members.map((m) => ({
        agentId: m.agentId,
        role: m.role?.trim() || undefined,
        responsibility: m.responsibility?.trim() || undefined,
        rolePrompt: m.rolePrompt,
      })),
      policy: {
        maxParallel,
        requireReview,
        ...(requireReview && reviewAgentId ? { reviewAgentId } : {}),
      },
    };
    setSaving(true);
    try {
      if (isEdit && team) await api.updateTeam(auth, team.id, body);
      else await api.createTeam(auth, body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="text-[12px] text-muted transition-colors hover:text-fg">
          ← 返回
        </button>
        <h3 className="text-[13px] font-semibold text-fg">{isEdit ? "编辑团队" : "新建团队"}</h3>
      </div>
      {err && <Alert>{err}</Alert>}

      <Field label="团队名称">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：调研小队"
          maxLength={80}
        />
      </Field>
      {!isEdit && (
        <Field label="团队 ID（英文/数字/-/_，创建后不可改）">
          <input
            className={inputCls}
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            placeholder="research-squad"
            maxLength={48}
          />
        </Field>
      )}
      <Field label="简介（可选）">
        <input
          className={inputCls}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话描述这个团队干什么"
          maxLength={300}
        />
      </Field>
      <Field label="队长">
        <select
          className={inputCls}
          value={leaderAgentId}
          onChange={(e) => setLeaderAgentId(e.target.value)}
        >
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted">
            成员（{members.length}/{MAX_MEMBERS}）
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={addMember}
            disabled={members.length >= MAX_MEMBERS}
          >
            <Plus size={13} />
            添加成员
          </Button>
        </div>
        {members.length === 0 && (
          <p className="text-[12px] text-faint">还没有成员，点「添加成员」。</p>
        )}
        {members.map((m, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <select
                className={inputCls}
                value={m.agentId}
                onChange={(e) => updateMember(i, { agentId: e.target.value })}
              >
                {memberOptions(m.agentId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeMember(i)}
                title="移除"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-danger-soft hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <input
              className={inputCls}
              value={m.role ?? ""}
              onChange={(e) => updateMember(i, { role: e.target.value })}
              placeholder="角色（可选，如：资料搜集）"
              maxLength={40}
            />
            <input
              className={inputCls}
              value={m.responsibility ?? ""}
              onChange={(e) => updateMember(i, { responsibility: e.target.value })}
              placeholder="职责说明（可选）"
              maxLength={200}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border p-3.5">
        <p className="text-[12px] font-semibold text-fg">协作策略</p>
        <Field label={`最大并发委派（1–${MAX_PARALLEL}）`}>
          <select
            className={inputCls}
            value={maxParallel}
            onChange={(e) => setMaxParallel(Number(e.target.value))}
          >
            {Array.from({ length: MAX_PARALLEL }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-fg">强制复核</p>
            <p className="text-[11px] leading-snug text-faint">
              交付前必须先让复核者审过，服务端硬校验（不通过不能收尾）。
            </p>
          </div>
          <Switch checked={requireReview} onCheckedChange={setRequireReview} />
        </div>
        {requireReview && (
          <Field label="复核者">
            <select
              className={inputCls}
              value={reviewAgentId}
              onChange={(e) => setReviewAgentId(e.target.value)}
            >
              <option value="">— 选择复核者 —</option>
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "保存中…" : isEdit ? "保存修改" : "创建团队"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
