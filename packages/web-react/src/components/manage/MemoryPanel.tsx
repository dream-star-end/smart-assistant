import { Check, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, MemoryFileMeta, MemoryIndexResponse } from "../../lib/types";
import { cn, relativeTime } from "../../lib/utils";
import { Alert, Badge, Button, Input, Modal, PanelHeader, Textarea, useConfirm } from "../ui";

/**
 * 记忆中心（memdir 范式）。两块权威语义:
 *  - **核心记忆**（memory,per-agent）:每条记忆 = 一个 frontmatter 文件 + MEMORY.md 纯索引。
 *    UI 呈现为**文件列表**(name/description/type/mtime 卡片),点开查看/编辑正文(乐观锁 409)、
 *    删除、新建。索引正文(MEMORY.md)只读折叠预览。智能体切换器只作用于核心记忆。
 *  - **用户画像**（user,用户级共享）:去 § 化的单文档纯 markdown,单文本编辑 + 乐观锁 409
 *    (画像与所选智能体无关,不随切换器重载)。
 * 旧的 §-blob 多条目编辑器 + blob PUT 已随后端 memdir 化退役。
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
  // 选中项必须在可选列表内（agent 刚被卸载时回落到列表首项/传入项）。
  const effective = agents.some((a) => a.id === selected) ? selected : agentId;
  const showPicker = agents.length > 1;

  return (
    <div className="flex flex-col">
      <PanelHeader title="记忆" hint="这些内容会注入智能体的长期上下文，让它越用越懂你。" />
      <div className="border-t border-border">
        <CoreMemorySection
          key={`core:${effective}`}
          auth={auth}
          agentId={effective}
          picker={
            showPicker ? (
              <AgentSelect value={effective} agents={agents} onChange={setSelected} />
            ) : undefined
          }
        />
      </div>
      <div className="border-t border-border">
        {/* 画像共享,用初始 agentId(稳定)做路由参数,不随切换器重载。 */}
        <UserProfileSection key="shared:user" auth={auth} agentId={agentId} />
      </div>
    </div>
  );
}

/** 核心记忆分区的智能体切换器。 */
function AgentSelect({
  value,
  agents,
  onChange,
}: {
  value: string;
  agents: { id: string; name: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-faint">
      智能体
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border bg-surface px-2 py-1 text-[12.5px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
      >
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
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

/** 记忆文件名规则（与后端 MEMORY_FILE_RE 一致,防路径穿越）。 */
const MEMORY_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;

/** epoch ms → 中文相对时间。 */
function relTime(ms: number): string {
  if (!ms || ms <= 0) return "";
  return relativeTime(new Date(ms).toISOString());
}

/** 新建记忆的正文骨架（预填 frontmatter name/description/type）。 */
function memoryFileTemplate(rawName: string): string {
  const name = rawName.replace(/\.md$/i, "").trim();
  return [
    "---",
    `name: ${name || "记忆名称"}`,
    "description: 一句话描述这条记忆（决定未来会话是否召回）",
    "type: project",
    "---",
    "",
    "在这里写下记忆正文。",
    "",
  ].join("\n");
}

function CoreMemorySection({
  auth,
  agentId,
  picker,
}: {
  auth: AuthSession;
  agentId: string;
  picker?: React.ReactNode;
}) {
  const [index, setIndex] = useState<MemoryIndexResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<MemoryFileMeta | null>(null);
  const [creating, setCreating] = useState(false);
  const [showIndex, setShowIndex] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getMemoryIndex(auth, agentId)
      .then((d) => {
        if (alive) setIndex(d);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载记忆失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, reloadKey]);

  const files = index?.files ?? [];
  const indexText = (index?.text ?? "").trim();

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium text-fg">核心记忆</span>
        <span className="flex items-center gap-2.5">
          <span className="text-[11.5px] text-faint">该智能体自己的观察与经验 · 按智能体独立保存</span>
          {picker}
        </span>
      </div>
      {err && (
        <Alert tone="danger" className="mt-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      {loading ? (
        <LoadingRow />
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11.5px] text-faint">{files.length} 条记忆</span>
            <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
              <Plus size={14} /> 新建记忆
            </Button>
          </div>
          {files.length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-faint">
              暂无核心记忆。智能体会在对话中自动记录，你也可以点「新建记忆」手动补充。
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {files.map((f) => (
                <MemoryFileCard key={f.file} file={f} onOpen={() => setEditing(f)} />
              ))}
            </ul>
          )}
          {indexText && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowIndex((v) => !v)}
                aria-expanded={showIndex}
                className="flex items-center gap-1 text-[11.5px] text-faint outline-none transition-colors hover:text-fg focus-visible:text-fg"
              >
                <ChevronRight
                  size={13}
                  aria-hidden="true"
                  className={cn("transition-transform", showIndex && "rotate-90")}
                />
                索引原文（MEMORY.md · 只读）
              </button>
              {showIndex && (
                <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-code px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg">
                  {indexText}
                </pre>
              )}
            </div>
          )}
        </>
      )}
      {editing && (
        <MemoryFileEditor
          auth={auth}
          agentId={agentId}
          file={editing}
          onReload={reload}
          onClose={() => setEditing(null)}
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
          }}
        />
      )}
    </div>
  );
}

function MemoryFileCard({ file, onOpen }: { file: MemoryFileMeta; onOpen: () => void }) {
  const typeMeta = TYPE_META[file.type] ?? { label: file.type || "记忆", tone: "neutral" as const };
  const title = file.name?.trim() || file.file.replace(/\.md$/i, "");
  const when = relTime(file.mtimeMs);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-1 rounded-2xl border border-border bg-elevated px-3.5 py-3 text-left shadow-soft outline-none transition-colors hover:border-accent hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-semibold text-fg">{title}</span>
          <Badge tone={typeMeta.tone}>{typeMeta.label}</Badge>
        </div>
        {file.description?.trim() && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-muted">{file.description}</p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-faint">
          <span className="min-w-0 truncate font-mono">{file.file}</span>
          {when && <span>· {when}</span>}
        </div>
      </button>
    </li>
  );
}

// ── 单文件查看/编辑（模态） ───────────────────────────────────────────────────

function MemoryFileEditor({
  auth,
  agentId,
  file,
  onReload,
  onClose,
}: {
  auth: AuthSession;
  agentId: string;
  file: MemoryFileMeta;
  /** 保存/删除后刷新外层列表(不关闭编辑器)。 */
  onReload: () => void;
  onClose: () => void;
}) {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState<{ content: string; version: string }>({ content: "", version: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 409:该文件被别处修改。持有服务端最新正文+version,提供「刷新」以最新为基线(保留用户当前编辑)。
  const [conflict, setConflict] = useState<{ content: string; version: string } | null>(null);
  const [confirm, confirmEl] = useConfirm();

  const title = file.name?.trim() || file.file.replace(/\.md$/i, "");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getMemoryFile(auth, agentId, file.file)
      .then((d) => {
        if (!alive) return;
        setContent(d.content);
        setBaseline({ content: d.content, version: d.version });
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载记忆内容失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId, file.file]);

  const dirty = content !== baseline.content;

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await api.putMemoryFile(auth, agentId, file.file, content, baseline.version || undefined);
      if (res.ok) {
        setBaseline({ content, version: res.version });
        setConflict(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
        onReload();
        return;
      }
      // 版本落后:不覆盖,提示 + 保留用户未保存文本,等用户点「刷新」后再存。
      setConflict(res.conflict);
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, file.file, content, baseline.version, onReload]);

  // 刷新:采纳服务端最新 version 作为基线(保留用户当前编辑),清冲突 → 再次保存以用户版本覆盖。
  const refreshBaseline = useCallback(() => {
    setConflict((c) => {
      if (c) setBaseline((b) => ({ ...b, version: c.version }));
      return null;
    });
  }, []);

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
      onClose();
    } catch (e) {
      setErr((e as Error).message || "删除失败");
      setDeleting(false);
    }
  }, [auth, agentId, file.file, title, confirm, onReload, onClose]);

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={title}
        description={file.file}
        className="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={remove} disabled={deleting || saving} className="text-danger hover:bg-danger-soft">
              <Trash2 size={14} /> 删除
            </Button>
            <div className="flex-1" />
            <Button
              variant="primary"
              onClick={save}
              disabled={!dirty || saving || loading || deleting || !!conflict}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
          </>
        }
      >
        {loading ? (
          <LoadingRow />
        ) : (
          <>
            {err && (
              <Alert tone="danger" className="mb-2 text-[12.5px]">
                {err}
              </Alert>
            )}
            {conflict && (
              <Alert tone="warning" className="mb-2 text-[12.5px]">
                <div>这条记忆已被智能体或其他页面修改。你未保存的内容仍保留在下方。</div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-accent hover:underline">查看最新内容</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
                    {conflict.content}
                  </pre>
                </details>
                <Button variant="primary" size="sm" className="mt-2" onClick={refreshBaseline}>
                  刷新
                </Button>
              </Alert>
            )}
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={16}
              spellCheck={false}
              placeholder="---\nname: …\ndescription: …\ntype: project\n---\n正文…"
              className="min-h-[16rem] resize-y font-mono text-[12.5px] leading-relaxed"
            />
            <p className="mt-1.5 text-[11px] text-faint">
              正文首部 frontmatter（name / description / type）决定索引标题与召回；智能体按 description 判断是否调用这条记忆。
            </p>
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
  const [slug, setSlug] = useState("");
  const [content, setContent] = useState(() => memoryFileTemplate(""));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 缺 .md 自动补全 → 最终落盘文件名(校验/建立都用它)。
  const trimmed = slug.trim();
  const filename = trimmed ? (/\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`) : "";
  const validName = MEMORY_FILE_RE.test(filename);
  const duplicate = validName && existing.includes(filename);

  // 未手动编辑正文时,骨架随文件名自动填 name。
  useEffect(() => {
    if (!touched) setContent(memoryFileTemplate(filename));
  }, [filename, touched]);

  const nameError =
    trimmed && !validName
      ? "文件名需以字母或数字开头，仅含字母数字与 - _，并以 .md 结尾（≤64 字符）"
      : duplicate
        ? "已存在同名记忆文件，请换个名字"
        : null;
  const canSubmit = validName && !duplicate && content.trim().length > 0 && !saving;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await api.putMemoryFile(auth, agentId, filename, content, undefined);
      if (res.ok) {
        onCreated();
        return;
      }
      // 新建理论上不冲突(undefined version 不做校验);真撞名给友好提示。
      setErr("同名记忆文件已被创建，请换个文件名。");
    } catch (e) {
      setErr((e as Error).message || "创建失败");
    } finally {
      setSaving(false);
    }
  }, [canSubmit, auth, agentId, filename, content, onCreated]);

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="新建记忆"
      description="每条记忆一个文件，会随 MEMORY.md 索引注入智能体上下文。"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            创建
          </Button>
        </>
      }
    >
      {err && (
        <Alert tone="danger" className="mb-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      <label htmlFor="mem-new-slug" className="block text-[12px] font-medium text-fg">
        文件名
      </label>
      <Input
        id="mem-new-slug"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        placeholder="例如 user-preferences（可省略 .md）"
        className="mt-1"
        autoComplete="off"
        spellCheck={false}
      />
      {nameError ? (
        <p className="mt-1 text-[11.5px] text-danger">{nameError}</p>
      ) : validName ? (
        <p className="mt-1 text-[11.5px] text-faint">
          将创建 <span className="font-mono text-muted">memory/{filename}</span>
        </p>
      ) : (
        <p className="mt-1 text-[11.5px] text-faint">字母/数字开头，仅含字母数字与 - _，以 .md 结尾。</p>
      )}
      <label htmlFor="mem-new-body" className="mt-3 block text-[12px] font-medium text-fg">
        正文
      </label>
      <Textarea
        id="mem-new-body"
        value={content}
        onChange={(e) => {
          setTouched(true);
          setContent(e.target.value);
        }}
        rows={12}
        spellCheck={false}
        className="mt-1 min-h-[12rem] resize-y font-mono text-[12.5px] leading-relaxed"
      />
      <p className="mt-1.5 text-[11px] text-faint">
        首部 frontmatter 的 description 决定未来会话是否召回这条记忆。
      </p>
    </Modal>
  );
}

// ── 用户画像（单文本编辑 + 409） ─────────────────────────────────────────────

function UserProfileSection({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const [text, setText] = useState("");
  // baseline = 最近一次已知的服务端权威态（text + 乐观锁 version），冲突后刷新到最新。
  const [baseline, setBaseline] = useState<{ text: string; version: string }>({ text: "", version: "" });
  const [limit, setLimit] = useState(0); // 字符预算（来自 GET）；0 = 不强制。
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // 冲突刷新提示（info，非报错）。
  const [serverLatest, setServerLatest] = useState<string | null>(null); // 冲突后服务端最新画像(供查看)。

  useEffect(() => {
    let alive = true;
    setLoading(true);
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
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message || "加载用户画像失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, agentId]);

  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const dirty = norm(text) !== norm(baseline.text);
  const chars = norm(text).trim().length;
  const overLimit = limit > 0 && text.length > limit;

  const save = useCallback(async () => {
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
      setNotice("智能体在你编辑期间更新了用户画像，已刷新基线；确认下方最新内容后再次保存，将以你的版本为准。");
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, text, baseline.text, baseline.version]);

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium text-fg">用户画像</span>
        <span className="text-[11.5px] text-faint">关于你的背景信息 · 所有智能体共享</span>
      </div>
      {err && (
        <Alert tone="danger" className="mt-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      {notice && (
        <Alert tone="info" className="mt-2 text-[12.5px]">
          <div>{notice}</div>
          {serverLatest !== null && (
            <details className="mt-1">
              <summary className="cursor-pointer text-accent hover:underline">查看最新画像</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
                {serverLatest || "（空）"}
              </pre>
            </details>
          )}
        </Alert>
      )}
      {loading ? (
        <LoadingRow />
      ) : (
        <>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={saving}
            rows={8}
            placeholder="例如：称呼、职业背景、常用项目与偏好、沟通风格…"
            className="mt-2 min-h-[8rem] resize-y text-[13px] leading-relaxed"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={!dirty || saving || overLimit}
              title={
                overLimit ? `已超出字符预算（${text.length}/${limit}），请精简后再保存` : undefined
              }
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
            <span className={cn("text-[11.5px]", overLimit ? "font-medium text-danger" : "text-faint")}>
              {overLimit ? text.length : chars}
              {limit > 0 ? `/${limit}` : ""} 字符
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="mt-2 flex items-center gap-2 py-6 text-[13px] text-faint">
      <Loader2 size={14} className="animate-spin" /> 加载中…
    </div>
  );
}
