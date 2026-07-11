import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import type { ApiKeySummary, AuthSession, CreatedApiKey } from "../../lib/types";
import { Alert, Button, Input, Spinner, useConfirm } from "../ui";
import { shortTime } from "./labels";

/**
 * API Key 自管：list / create（一次性明文展示）/ delete。
 *
 * commercial-only：后端当前是 admin-only rollout，普通用户调用返 403 —— 命中即整段
 * 隐藏（不暴露"有这功能但你没权限"的噪音）。明文仅创建时返回一次，强制引导即时复制。
 */
export function ApiKeysSection({ auth }: { auth: AuthSession }) {
  const [hidden, setHidden] = useState(false);
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listApiKeys(auth)
      .then((ks) => {
        if (alive) setKeys(ks);
      })
      .catch((e) => {
        if (!alive) return;
        // 403 = admin-only rollout：整段隐藏，普通用户无感。
        if (e instanceof ApiError && e.status === 403) {
          setHidden(true);
          return;
        }
        setErr(apiErrorMessage(e, "加载 API Key 失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function create() {
    const l = label.trim();
    if (!l || creating) return;
    setCreating(true);
    setErr(null);
    try {
      const created = await api.createApiKey(auth, l);
      setJustCreated(created);
      setCopied(false);
      setLabel("");
      setKeys((prev) => [
        {
          id: created.id,
          label: created.label,
          keyPrefix: created.keyPrefix,
          createdAt: created.createdAt,
          lastUsedAt: null,
        },
        ...(prev ?? []),
      ]);
    } catch (e) {
      setErr(apiErrorMessage(e, "创建失败"));
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    const ok = await confirmDialog({
      title: "撤销该 API Key?",
      body: "使用它的集成将立即失效,不可恢复。",
      confirmText: "撤销",
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    try {
      await api.deleteApiKey(auth, id);
      setKeys((prev) => (prev ?? []).filter((k) => k.id !== id));
      if (justCreated?.id === id) setJustCreated(null);
    } catch (e) {
      setErr(apiErrorMessage(e, "撤销失败"));
    }
  }

  async function copyPlaintext() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.plaintext);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (hidden) return null;

  return (
    <div className="border-t border-border px-5 py-4">
      {confirmDialogEl}
      <div className="flex items-center gap-1.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        <KeyRound size={13} /> API Key
      </div>

      {err && (
        <Alert tone="danger" className="mb-2 text-[12.5px]">
          {err}
        </Alert>
      )}

      {justCreated && (
        <Alert tone="warning" className="mb-3 flex flex-col gap-2 text-[12.5px]">
          <span>请立即复制并妥善保存，关闭后将无法再次查看完整密钥。</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-bg px-2 py-1 font-mono text-[12px] text-fg">
              {justCreated.plaintext}
            </code>
            <Button variant="secondary" size="sm" onClick={copyPlaintext}>
              <Copy size={13} /> {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </Alert>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="新密钥名称（如 my-cli）"
          maxLength={64}
          className="h-auto bg-bg px-3 py-2 text-[13.5px]"
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={create}
          disabled={creating || !label.trim()}
          className="shrink-0"
        >
          {creating ? "创建中…" : "创建"}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-faint">
          <Spinner /> 加载中…
        </div>
      ) : !keys || keys.length === 0 ? (
        <p className="py-3 text-center text-[12.5px] text-faint">还没有 API Key</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-fg">{k.label}</span>
                <span className="block truncate font-mono text-[11.5px] text-faint">
                  {k.keyPrefix}··· · {shortTime(k.createdAt)}
                  {k.lastUsedAt ? ` · 最近使用 ${shortTime(k.lastUsedAt)}` : " · 从未使用"}
                </span>
              </span>
              <button
                onClick={() => remove(k.id)}
                aria-label="撤销"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
