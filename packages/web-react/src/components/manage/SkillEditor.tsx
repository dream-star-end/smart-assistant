/**
 * 技能编辑器 —— 多文件技能的完整编辑面(管理中心 → 技能 → 编辑)。
 *
 * 布局:左侧目录树(SKILL.md + references/ scripts/ assets/ evals/ 分组),
 * 点文件右侧编辑;SKILL.md 走 描述+正文(保存自动入版本历史),辅助文件走
 * 原文编辑;支持新建/删除辅助文件;「历史」页签列出版本快照,可一键恢复
 * (恢复以新版本号写回,永远可再回滚)。只读技能(市场安装/agent-seed)全程只读。
 */
import {
  Check,
  ChevronRight,
  Clock,
  FilePlus,
  FileText,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type { AuthSession, MarketplaceMyAgent, SkillDetail } from "../../lib/types";
import { cn } from "../../lib/utils";
import { AgentScopePicker, AgentScopeSummary, normalizeAgentScope } from "../AgentScopePicker";
import { Alert, Badge, Button, Input, Modal, Spinner, Textarea, useConfirm } from "../ui";

const AUX_PREFIXES = ["references/", "assets/", "evals/", "scripts/"];

type Tab = "files" | "history";

export function SkillEditor({
  auth,
  skillName,
  open,
  onClose,
  onChanged,
}: {
  auth: AuthSession;
  skillName: string;
  open: boolean;
  onClose: () => void;
  /** 保存/恢复/删文件后通知外层刷新列表。 */
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("files");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("SKILL.md");
  // SKILL.md 编辑态(描述+正文);辅助文件编辑态(原文)。
  const [desc, setDesc] = useState("");
  const [body, setBody] = useState("");
  const [agents, setAgents] = useState<MarketplaceMyAgent[]>([]);
  const [scopeIds, setScopeIds] = useState<string[]>(["main"]);
  const [scopeDirty, setScopeDirty] = useState(false);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [history, setHistory] = useState<Array<{ version: string; timestamp: string }>>([]);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  // 目录树开合:移动端默认收起(右侧编辑区太窄),桌面默认展开;选完文件在窄屏自动收起。
  const [treeOpen, setTreeOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 640,
  );
  const pickFile = useCallback((path: string) => {
    setSelected(path);
    if (typeof window !== "undefined" && window.innerWidth < 640) setTreeOpen(false);
  }, []);

  const writable = detail?.writable === true;
  const scopeEditable = writable && detail?.layer === "shared";

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    Promise.all([api.getSkill(auth, skillName), api.listMyAgents(auth).catch(() => [] as MarketplaceMyAgent[])])
      .then(([d, a]) => {
        setDetail(d);
        setDesc(d.description ?? "");
        setBody(d.body ?? "");
        setAgents(a.length ? a : [{ id: "main", slug: "main", name: "全能助手", description: "", installed: true, isDefault: true }]);
        setScopeIds(normalizeAgentScope(d.agentIds));
        setScopeDirty(false);
        setDirty(false);
      })
      .catch((e) => setErr(apiErrorMessage(e, "加载技能失败")))
      .finally(() => setLoading(false));
  }, [auth, skillName]);

  useEffect(() => {
    if (open) {
      setTab("files");
      setSelected("SKILL.md");
      load();
    }
  }, [open, load]);

  // 选中辅助文件时拉取内容。
  useEffect(() => {
    if (!open || selected === "SKILL.md") return;
    setFileLoading(true);
    setFileContent("");
    api
      .getSkillFile(auth, skillName, selected)
      .then((r) => setFileContent(r.content))
      .catch((e) => setErr(apiErrorMessage(e, "读取文件失败")))
      .finally(() => setFileLoading(false));
    setDirty(false);
  }, [open, selected, auth, skillName]);

  useEffect(() => {
    if (open && tab === "history") {
      api
        .getSkillHistory(auth, skillName)
        .then((r) => setHistory(r.history))
        .catch(() => setHistory([]));
    }
  }, [open, tab, auth, skillName]);

  // 目录树:SKILL.md 置顶,其余按 目录/文件 分组排序(history/ 不展示,恢复走历史页签)。
  const tree = useMemo(() => {
    const files = (detail?.files ?? []).filter(
      (f) => f !== "SKILL.md" && !f.startsWith("history/"),
    );
    const groups = new Map<string, string[]>();
    for (const f of files.sort()) {
      const dir = f.includes("/") ? f.split("/")[0] : "";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)?.push(f);
    }
    return groups;
  }, [detail]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      if (selected === "SKILL.md") {
        if (scopeDirty && !dirty) {
          await api.updateSkill(auth, skillName, { agentIds: scopeIds });
        } else {
          await api.updateSkill(auth, skillName, {
            description: desc.trim(),
            body,
            tags: detail?.tags,
            ...(scopeEditable ? { agentIds: scopeIds } : {}),
          });
        }
      } else {
        await api.putSkillFile(auth, skillName, selected, fileContent);
      }
      setDirty(false);
      setScopeDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      onChanged();
      if (selected === "SKILL.md") load();
    } catch (e) {
      setErr(apiErrorMessage(e, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const createFile = async () => {
    const path = newPath.trim();
    if (!path) return;
    if (!AUX_PREFIXES.some((p) => path.startsWith(p))) {
      setErr(`新文件路径须以 ${AUX_PREFIXES.join(" / ")} 开头`);
      return;
    }
    try {
      await api.putSkillFile(auth, skillName, path, "");
      setNewPath("");
      load();
      setSelected(path);
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, "创建失败"));
    }
  };

  const removeFile = async (path: string) => {
    const ok = await confirmDialog({
      title: `删除文件「${path}」?`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSkillFile(auth, skillName, path);
      if (selected === path) setSelected("SKILL.md");
      load();
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, "删除失败"));
    }
  };

  const restore = async (version: string) => {
    const ok = await confirmDialog({
      title: `恢复到 v${version}?`,
      body: "以新版本号写回当前正文(现有内容会先存入历史,可再次回滚)。",
      confirmText: "恢复",
    });
    if (!ok) return;
    try {
      await api.restoreSkillVersion(auth, skillName, version);
      load();
      setTab("files");
      setSelected("SKILL.md");
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, "恢复失败"));
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`编辑技能:${skillName}`}
      description={writable ? "多文件技能:左侧选文件,右侧编辑。" : "只读技能(市场安装/平台内置),仅可查看。"}
      className="h-[min(88vh,50rem)] max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {tab === "files" && writable && (
            <Button variant="primary" onClick={save} disabled={(!dirty && !scopeDirty) || saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
          )}
        </>
      }
    >
      {confirmDialogEl}
      {err && (
        <Alert tone="danger" className="mb-2">
          {err}
        </Alert>
      )}
      <div className="mb-2 flex items-center gap-1">
        {tab === "files" && !loading && (
          <button
            type="button"
            onClick={() => setTreeOpen((o) => !o)}
            aria-label={treeOpen ? "收起目录" : "展开目录"}
            title={treeOpen ? "收起目录" : "展开目录"}
            className="flex size-6 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            {treeOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
        )}
        {(
          [
            { id: "files", label: "文件" },
            { id: "history", label: `历史${history.length ? `（${history.length}）` : ""}` },
          ] as Array<{ id: Tab; label: string }>
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              tab === t.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-faint">
          <Spinner /> 加载技能…
        </div>
      ) : tab === "history" ? (
        <div className="flex flex-col gap-1.5">
          {history.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-faint">
              还没有历史版本 —— 每次保存正文都会自动快照旧版到这里。
            </p>
          ) : (
            history.map((h) => (
              <div
                key={h.version}
                className="flex items-center gap-2.5 rounded-lg border border-border bg-bg px-3 py-2"
              >
                <Clock size={14} className="shrink-0 text-accent" />
                <Badge tone="neutral">v{h.version}</Badge>
                <span className="text-[12px] text-faint">
                  {new Date(h.timestamp).toLocaleString("zh-CN")}
                </span>
                {writable && (
                  <Button variant="secondary" size="sm" className="ml-auto" onClick={() => restore(h.version)}>
                    恢复此版本
                  </Button>
                )}
              </div>
            ))
          )}
          <p className="mt-1 text-[11.5px] text-faint">历史快照覆盖 SKILL.md 正文;辅助文件不入快照。</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3" style={{ height: "calc(100% - 2.5rem)" }}>
          {/* 左:目录树(可收起;窄屏 max-w 护栏,不让右侧编辑区被压没) */}
          {treeOpen && (
          <div className="flex w-56 max-w-[45vw] shrink-0 flex-col overflow-y-auto rounded-lg border border-border bg-bg p-2">
            <FileNode
              label="SKILL.md"
              active={selected === "SKILL.md"}
              onClick={() => pickFile("SKILL.md")}
            />
            {[...tree.entries()].map(([dir, files]) =>
              dir === "" ? (
                files.map((f) => (
                  <FileNode key={f} label={f} active={selected === f} onClick={() => pickFile(f)} onDelete={writable ? () => removeFile(f) : undefined} />
                ))
              ) : (
                <div key={dir} className="mt-1">
                  <div className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-faint">
                    <ChevronRight size={11} className="rotate-90" /> {dir}/
                  </div>
                  {files.map((f) => (
                    <FileNode
                      key={f}
                      label={f.slice(dir.length + 1)}
                      indent
                      active={selected === f}
                      onClick={() => pickFile(f)}
                      onDelete={writable ? () => removeFile(f) : undefined}
                    />
                  ))}
                </div>
              ),
            )}
            {writable && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="flex items-center gap-1">
                  <Input
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    placeholder="scripts/gen.sh"
                    className="h-7 font-mono text-[11px]"
                    onKeyDown={(e) => e.key === "Enter" && createFile()}
                  />
                  <button
                    type="button"
                    onClick={createFile}
                    aria-label="新建文件"
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"
                  >
                    <FilePlus size={14} />
                  </button>
                </div>
                <p className="mt-1 text-[10.5px] leading-snug text-faint">
                  references/ assets/ evals/ scripts/
                </p>
              </div>
            )}
          </div>
          )}

          {/* 右:编辑器 */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
            {selected === "SKILL.md" ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-muted">描述(触发的唯一依据:做什么 + 何时用)</span>
                  <Input
                    value={desc}
                    disabled={!writable}
                    onChange={(e) => {
                      setDesc(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                {agents.length > 0 &&
                  (scopeEditable ? (
                    <AgentScopePicker
                      agents={agents}
                      selectedIds={scopeIds}
                      onChange={(ids) => {
                        setScopeIds(ids);
                        setScopeDirty(true);
                      }}
                      title="适用智能体"
                      hint="自建共享技能可改归属。"
                    />
                  ) : (
                    <div className="rounded-xl border border-border bg-surface/60 p-3 text-[12px] text-muted">
                      适用：<AgentScopeSummary agentIds={detail?.agentIds} agents={agents} />
                    </div>
                  ))}
                <label className="flex min-h-0 flex-1 flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-muted">
                    正文(v{detail?.version ?? "?"};保存后旧版自动入历史)
                  </span>
                  <Textarea
                    value={body}
                    disabled={!writable}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setDirty(true);
                    }}
                    className="min-h-[20rem] flex-1 resize-none font-mono text-[12.5px]"
                  />
                </label>
              </>
            ) : fileLoading ? (
              <div className="flex items-center gap-2 py-10 text-[12.5px] text-faint">
                <Spinner size={14} /> 读取 {selected}…
              </div>
            ) : (
              <label className="flex min-h-0 flex-1 flex-col gap-1">
                <span className="font-mono text-[11.5px] font-medium text-muted">{selected}</span>
                <Textarea
                  value={fileContent}
                  disabled={!writable}
                  onChange={(e) => {
                    setFileContent(e.target.value);
                    setDirty(true);
                  }}
                  className="min-h-[20rem] flex-1 resize-none font-mono text-[12px]"
                />
              </label>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function FileNode({
  label,
  active,
  indent,
  onClick,
  onDelete,
}: {
  label: string;
  active: boolean;
  indent?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-1",
        indent && "ml-3.5",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[11.5px] outline-none"
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`删除 ${label}`}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-danger-soft hover:text-danger group-hover:flex"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}
