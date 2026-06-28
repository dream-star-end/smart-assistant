import { ChevronRight, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, SkillDetail, SkillSummary } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Spinner } from "../ui";
import { EmptyState, PanelHeader } from "./parts";

/**
 * 技能库：列出用户可用技能（经容器代理 /api/skills），展开看正文（/api/skills/:name），
 * 可写的可删除（DELETE /api/skills/:name）。内置/只读技能仅查看。
 */
export function SkillsPanel({ auth }: { auth: AuthSession }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listSkills(auth)
      .then((s) => {
        // 纵深防御：平台内置技能绝不展示。后端容器已 includePlatform:false 不返回平台技能；
        // 这里再过滤一道，万一后端回归也不会漏到 UI。
        if (alive) setSkills(s.filter((sk) => sk.source !== "platform"));
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载技能失败");
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
      if (!confirm(`删除技能「${name}」？`)) return;
      try {
        await api.deleteSkill(auth, name);
        setReload((n) => n + 1);
      } catch (e) {
        setErr((e as Error).message || "删除失败");
      }
    },
    [auth],
  );

  return (
    <div className="flex flex-col">
      <PanelHeader title="技能" hint="完成复杂任务后智能体会把流程沉淀成可复用技能；也可从市场安装。" />
      {err && (
        <div className="px-5 pb-2">
          <Alert tone="danger" className="text-[12.5px]">
            {err}
          </Alert>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-faint">
          <Spinner /> 加载技能…
        </div>
      ) : !skills || skills.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="还没有技能"
          hint="在对话里让智能体「把这个流程存成技能」即可自动沉淀，或从市场安装。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5 px-4 pb-4">
          {skills.map((sk) => (
            <SkillRow key={sk.name} auth={auth} skill={sk} onDelete={() => remove(sk.name)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillRow({
  auth,
  skill,
  onDelete,
}: {
  auth: AuthSession;
  skill: SkillSummary;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && !detail && !loading) {
      setLoading(true);
      setErr(null);
      api
        .getSkill(auth, skill.name)
        .then(setDetail)
        .catch((e) => setErr((e as Error).message || "加载技能正文失败"))
        .finally(() => setLoading(false));
    }
  }, [open, detail, loading, auth, skill.name]);

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
      <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
        <Badge tone={skill.layer === "hub" ? "neutral" : "accent"}>
          {skill.layer === "hub" ? "市场" : "自建"}
        </Badge>
        {skill.writable === false && <Badge tone="neutral">只读</Badge>}
        {(skill.tags ?? []).slice(0, 6).map((t) => (
          <Badge key={t} tone="neutral">
            {t}
          </Badge>
        ))}
      </div>
      {open && (
        <div className="border-t border-border px-3.5 py-3">
          {loading ? (
            <div className="flex items-center gap-2 text-[12.5px] text-faint">
              <Loader2 size={14} className="animate-spin" /> 加载正文…
            </div>
          ) : err ? (
            <span className="text-[12.5px] text-danger">{err}</span>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">
              {detail?.body || "（无正文）"}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
