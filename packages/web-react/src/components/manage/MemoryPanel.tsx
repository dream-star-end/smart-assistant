import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, PanelHeader } from "../ui";

// 记忆按 "\n§\n" 分隔成多条目（与 storage/memoryStore.ts 的 ENTRY_DELIMITER 一致）。
const DELIM = "\n§\n";
type Target = "memory" | "user";
type Entry = { id: number; text: string };

// 顺序有意:先共享的用户画像,后 per-agent 的核心记忆(与后端语义一致:
// user → 用户级共享文件,memory → per-agent 文件,见 storage/memoryStore.ts)。
const DOCS: { key: Target; label: string; hint: string; shared?: boolean }[] = [
  { key: "user", label: "用户画像", hint: "关于你的背景信息 · 所有角色共享", shared: true },
  { key: "memory", label: "核心记忆", hint: "该角色自己的观察与经验 · 按角色独立保存" },
];

function splitEntries(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(DELIM);
}
function joinEntries(texts: string[]): string {
  // 与后端 MemoryStore.overwrite 对齐：trim 每条并丢弃空条目，保证“保存后规范化”与实际持久化一致。
  return texts
    .map((t) => t.replace(/\r\n/g, "\n").trim())
    .filter((t) => t)
    .join(DELIM);
}

/**
 * 记忆中心：用户画像（user,**用户级共享** —— 换哪个角色都认识你）+ 核心记忆
 *（memory,**按角色独立** —— 各角色自己的观察互不串扰）。每个文档是 "\n§\n"
 * 分隔的多条目,逐条卡片化编辑,保存时重新拼接为整段经容器代理写回
 *（GET/PUT /api/agents/:id/memory/:target）。角色切换器只作用于核心记忆
 *（画像是共享文件,与所选角色无关,不给切换器造成"画像也分身"的误导）。
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
      <PanelHeader title="记忆" hint="这些内容会注入角色的长期上下文，让它越用越懂你。" />
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
                  角色
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
  /** 核心记忆分区的角色切换器(共享的用户画像不传)。 */
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
    return splitEntries(text).map((t) => ({ id: nextId.current++, text: t }));
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
        setOrig(joinEntries(splitEntries(text)));
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

  const current = joinEntries(entries.map((e) => e.text));
  const dirty = current !== orig;
  const nonEmpty = entries.filter((e) => e.text.trim()).length;

  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      const text = joinEntries(entries.map((e) => e.text));
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
            <ul className="mt-1 flex flex-col gap-2">
              {entries.map((entry) => (
                <li key={entry.id} className="rounded-lg border border-border bg-surface p-2.5">
                  <textarea
                    value={entry.text}
                    disabled={saving}
                    onChange={(e) =>
                      setEntries((es) =>
                        es.map((x) => (x.id === entry.id ? { ...x, text: e.target.value } : x)),
                      )
                    }
                    rows={2}
                    placeholder="一条记忆…"
                    className="w-full resize-y bg-transparent font-mono text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-60"
                  />
                  <div className="mt-0.5 flex justify-end">
                    <button
                      onClick={() => setEntries((es) => es.filter((x) => x.id !== entry.id))}
                      disabled={saving}
                      aria-label="删除条目"
                      className="flex size-6 items-center justify-center rounded text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
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
