import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession } from "../../lib/types";
import { Alert, Button } from "../ui";
import { PanelHeader } from "./parts";

type Target = "memory" | "user";
const DOCS: { key: Target; label: string; hint: string; placeholder: string }[] = [
  { key: "memory", label: "核心记忆", hint: "智能体长期记住的关键事实与偏好", placeholder: "（暂无核心记忆，可在此手写补充）" },
  { key: "user", label: "用户画像", hint: "关于你的背景信息，帮助智能体更懂你", placeholder: "（暂无用户画像）" },
];

/**
 * 记忆中心：核心记忆（memory）+ 用户画像（user）两个文档，经容器代理读写
 * （GET/PUT /api/agents/:id/memory/:target）。按当前对话 agent 维度。
 */
export function MemoryPanel({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  return (
    <div className="flex flex-col">
      <PanelHeader title="记忆" hint="这些内容会注入智能体的长期上下文，让它越用越懂你。" />
      {DOCS.map((d) => (
        <div key={d.key} className="border-t border-border">
          <MemoryDoc auth={auth} agentId={agentId} target={d.key} meta={d} />
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
}: {
  auth: AuthSession;
  agentId: string;
  target: Target;
  meta: { label: string; hint: string; placeholder: string };
}) {
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getMemory(auth, agentId, target)
      .then((d) => {
        if (!alive) return;
        setText(d.text || "");
        setOrig(d.text || "");
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
  }, [auth, agentId, target]);

  const dirty = text !== orig;
  const save = useCallback(async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.putMemory(auth, agentId, target, text);
      setOrig(text);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  }, [auth, agentId, target, text]);

  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-medium text-fg">{meta.label}</span>
        <span className="text-[11.5px] text-faint">{meta.hint}</span>
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
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={meta.placeholder}
            className="mt-2 min-h-[120px] w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={save} disabled={!dirty || saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
              {saved ? "已保存" : "保存"}
            </Button>
            <span className="text-[11.5px] text-faint">{text.length} 字符</span>
          </div>
        </>
      )}
    </div>
  );
}
