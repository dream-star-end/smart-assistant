import { Boxes, Check, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, OrgSkill, OrgSkillsResponse } from "../../lib/types";
import { Alert, Button, EmptyState, Spinner, useToast } from "../ui";
import { orgErrText } from "../OrgCenter";

/**
 * 技能：组织共享技能库。installed 区 + available 区两栏，install/uninstall。
 * 数据走批次 C 契约（GET /api/org/skills → {installed, available}）。集成期端点可能
 * 404/501：以 orgErrText 展示后端文案，绝不崩溃。变更后重拉列表。
 */
export function SkillsTab({ auth }: { auth: AuthSession }) {
  const [data, setData] = useState<OrgSkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const toast = useToast();

  // 首次挂载拉技能（依赖数组不含 loading，防转圈）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getOrgSkills(auth)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setErr(orgErrText(e, "加载组织技能失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function reload() {
    try {
      setData(await api.getOrgSkills(auth));
    } catch (e) {
      toast(orgErrText(e, "刷新技能列表失败"), "error");
    }
  }

  async function install(slug: string) {
    setBusySlug(slug);
    try {
      await api.installOrgSkill(auth, slug);
      await reload();
      toast("已安装到组织", "success");
    } catch (e) {
      toast(orgErrText(e, "安装技能失败"), "error");
    } finally {
      setBusySlug(null);
    }
  }

  async function uninstall(slug: string) {
    setBusySlug(slug);
    try {
      await api.uninstallOrgSkill(auth, slug);
      await reload();
      toast("已从组织移除", "success");
    } catch (e) {
      toast(orgErrText(e, "移除技能失败"), "error");
    } finally {
      setBusySlug(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载组织技能…
      </div>
    );
  }
  if (err) {
    return (
      <div className="px-5 py-4">
        <Alert tone="danger" className="text-[12.5px]">
          {err}
        </Alert>
      </div>
    );
  }
  if (!data) return null;

  const { installed, available } = data;

  if (installed.length === 0 && available.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="暂无组织技能"
        hint="组织共享技能库为空。上架后成员对话即可复用统一的组织技能。"
      />
    );
  }

  return (
    <div className="flex flex-col">
      <Section
        title="已安装"
        empty="组织尚未安装任何技能。"
        skills={installed}
        renderAction={(s) => (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => uninstall(s.slug)}
            disabled={busySlug === s.slug}
          >
            {busySlug === s.slug ? <Spinner size={14} /> : null}
            移除
          </Button>
        )}
      />
      <Section
        title="可安装"
        empty="没有可安装的技能。"
        skills={available}
        border
        renderAction={(s) => (
          <Button
            variant="primary"
            size="sm"
            onClick={() => install(s.slug)}
            disabled={busySlug === s.slug}
          >
            {busySlug === s.slug ? <Spinner size={14} /> : <Plus size={14} />}
            安装
          </Button>
        )}
      />
    </div>
  );
}

function Section({
  title,
  empty,
  skills,
  renderAction,
  border,
}: {
  title: string;
  empty: string;
  skills: OrgSkill[];
  renderAction: (s: OrgSkill) => ReactNode;
  border?: boolean;
}) {
  return (
    <div className={border ? "border-t border-border px-5 py-4" : "px-5 py-4"}>
      <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</div>
      {skills.length === 0 ? (
        <p className="py-3 text-center text-[12.5px] text-faint">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {skills.map((s) => (
            <li
              key={s.slug}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Check size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-fg">{s.name}</span>
                {s.summary && (
                  <span className="block truncate text-[11.5px] text-faint">{s.summary}</span>
                )}
              </span>
              <span className="shrink-0">{renderAction(s)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
