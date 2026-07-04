import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { deriveMemoryTitle, joinMemoryEntries, splitMemoryEntries } from "../../lib/memoryText";
import type { AuthSession } from "../../lib/types";
import { Alert, Badge, Button, PanelHeader } from "../ui";

type Target = "memory" | "user";
type Entry = { id: number; text: string };

// 顺序有意:先共享的用户画像,后 per-agent 的核心记忆(与后端语义一致:
// user → 用户级共享文件,memory → per-agent 文件,见 storage/memoryStore.ts)。
const DOCS: { key: Target; label: string; hint: string; shared?: boolean }[] = [
  { key: "user", label: "用户画像", hint: "关于你的背景信息 · 所有智能体共享", shared: true },
  { key: "memory", label: "核心记忆", hint: "该智能体自己的观察与经验 · 按智能体独立保存" },
];

/**
 * 记忆中心：用户画像（user,**用户级共享** —— 换哪个智能体都认识你）+ 核心记忆
 *（memory,**按智能体独立** —— 各智能体自己的观察互不串扰）。每个文档是 "\n§\n"
 * 分隔的多条目,逐条卡片化编辑,保存时重新拼接为整段经容器代理写回
 *（GET/PUT /api/agents/:id/memory/:target）。智能体切换器只作用于核心记忆
 *（画像是共享文件,与所选智能体无关,不给切换器造成"画像也分身"的误导）。
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
      {DOCS.map((d) => (
        <div key={d.key} className="border-t border-border">
          <MemoryDoc
            key={`${d.shared ? "shared" : effective}:${d.key}`}
            auth={auth}
            agentId={effective}
            target={d.key}
            meta={d}
            picker={
              !d.shared && showPicker ? (
                <label className="flex items-center gap-1.5 text-[12px] text-faint">
                  智能体
                  <select
                    value={effective}
                    onChange={(e) => setSelected(e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-[12.5px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
          />
        </div>
      ))}
    </div>
  );
}

function MemoryDoc({
  auth,
  agentId,
  target,
  meta,
  picker,
}: {
  auth: AuthSession;
  agentId: string;
  target: Target;
  meta: { label: string; hint: string };
  /** 核心记忆分区的智能体切换器(共享的用户画像不传)。 */
  picker?: React.ReactNode;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nextId = useRef(0);

  const toEntries = useCallback((text: string): Entry[] => {
    return splitMemoryEntries(text).map((t) => ({ id: nextId.current++, text: t }));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getMemory(auth, agentId, target)
      .then((d) => {
        if (!alive) return;
        const text = d.text || "";
        setEntries(toEntries(text));
        setOrig(joinMemoryEntries(splitMemoryEntries(text)));
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
  }, [auth, agentId, target, toEntries]);

  const current = joinMemoryEntries(entries.map((e) => e.text));
  const dirty = current !== orig;
  const nonEmpty = entries.filter((e) => e.text.trim()).length;

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const text = joinMemoryEntries(entries.map((e) => e.text));
      await api.putMemory(auth, agentId, target, text);
      setOrig(text);
      setEntries(toEntries(text)); // 规范化：去掉空条目
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, target, entries, toEntries]);

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-[13.5px] font-medium text-fg">{meta.label}</span>
        <span className="flex items-center gap-2.5">
          <span className="text-[11.5px] text-faint">{meta.hint}</span>
          {picker}
        </span>
      </div>
      {err && (
        <Alert tone="danger" className="mt-2 text-[12.5px]">
          {err}
        </Alert>
      )}
      {loading ? (
        <div className="mt-2 flex items-center gap-2 py-6 text-[13px] text-faint">
          <Loader2 size={14} className="animate-spin" /> 加载中…
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11.5px] text-faint">{nonEmpty} 条</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setEntries((es) => [{ id: nextId.current++, text: "" }, ...es])}
            >
              <Plus size={14} /> 新增条目
            </Button>
          </div>
          {entries.length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-faint">
              暂无{meta.label}，点「新增条目」手写补充。
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2.5">
              {entries.map((entry, index) => (
                <MemoryEntryCard
                  key={entry.id}
                  entry={entry}
                  index={index}
                  saving={saving}
                  dirty={joinMemoryEntries([entry.text]) !== joinMemoryEntries([splitMemoryEntries(orig)[index] || ""])}
                  onChange={(text) =>
                    setEntries((es) => es.map((x) => (x.id === entry.id ? { ...x, text } : x)))
                  }
                  onDelete={() => setEntries((es) => es.filter((x) => x.id !== entry.id))}
                />
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
            <span className="text-[11.5px] text-faint">{current.length} 字符</span>
          </div>
        </>
      )}
    </div>
  );
}
function MemoryEntryCard({
  entry,
  index,
  saving,
  dirty,
  onChange,
  onDelete,
}: {
  entry: Entry;
  index: number;
  saving: boolean;
  dirty: boolean;
  onChange: (text: string) => void;
  onDelete: () => void;
}) {
  const title = deriveMemoryTitle(entry.text, `记忆 ${index + 1}`);
  const chars = entry.text.replace(/\r\n/g, "\n").trim().length;
  return (
    <li className="rounded-2xl border border-border bg-elevated px-3.5 py-3 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge tone="accent">#{index + 1}</Badge>
            <span className="min-w-0 truncate text-[13px] font-semibold text-fg">{title}</span>
            {dirty && <Badge tone="warning">未保存</Badge>}
          </div>
          <p className="mt-0.5 text-[11.5px] text-faint">{chars} 字符</p>
        </div>
        <button
          onClick={onDelete}
          disabled={saving}
          aria-label="删除条目"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        value={entry.text}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(6, Math.max(3, entry.text.split("\n").length + 1))}
        placeholder="一条记忆…"
        className="mt-2 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
    </li>
  );
}
