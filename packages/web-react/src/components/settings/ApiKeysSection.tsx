import { Check, Copy, KeyRound, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import type { ApiKeyPatch, ApiKeySummary, AuthSession, CreatedApiKey } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Button, Input, Progress, Spinner, Switch, useConfirm } from "../ui";
import { shortTime } from "./labels";

/**
 * API Key 自管:list / create(一次性明文展示)/ rename / 临时禁用 / 单 key 上限 / 撤销。
 *
 * commercial-only:admin 角色由父组件先验控制挂载;403 隐藏仍作为角色变更竞态兜底。
 * `onKeysChange` 让父级(消耗统计的 key 下拉)与列表保持同步。
 */
export function ApiKeysSection({
  auth,
  onKeysChange,
}: {
  auth: AuthSession;
  onKeysChange?: (keys: ApiKeySummary[]) => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [keys, setKeysState] = useState<ApiKeySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  /** 正在被 PATCH 的 key id(禁用按钮防双击)。 */
  const [busyId, setBusyId] = useState<string | null>(null);

  const setKeys = (next: ApiKeySummary[] | ((prev: ApiKeySummary[] | null) => ApiKeySummary[])) => {
    setKeysState((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      onKeysChange?.(v);
      return v;
    });
  };

  // 本地 Claude Code 接入片段。base URL 取当前页面 origin(quick tunnel 域名会变,
  // 不能写死);ANTHROPIC_MODEL 必须显式指定 cursor-* —— 服务端不做 claude-* → cursor 别名。
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const claudeCodeSnippet = [
    `export ANTHROPIC_BASE_URL=${origin}/api/anthropic`,
    `export ANTHROPIC_AUTH_TOKEN=${justCreated?.plaintext ?? "oc-cc.<你的密钥>"}`,
    "export ANTHROPIC_MODEL=cursor-fable-5.1-high",
    "export ANTHROPIC_SMALL_FAST_MODEL=cursor-gemini-3.8-flash-low",
    "claude",
  ].join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: setKeys 是稳定包装,不进依赖。
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
        // 403 = admin-only rollout:整段隐藏,普通用户无感。
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
          disabledAt: null,
          creditLimit: null,
          spentCredits: "0",
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
      body: "使用它的集成将立即失效,不可恢复。如需暂停,请改用「禁用」。",
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

  async function patch(id: string, p: ApiKeyPatch): Promise<boolean> {
    if (busyId) return false;
    setBusyId(id);
    setErr(null);
    try {
      const updated = await api.updateApiKey(auth, id, p);
      setKeys((prev) => (prev ?? []).map((k) => (k.id === id ? updated : k)));
      return true;
    } catch (e) {
      setErr(apiErrorMessage(e, "更新失败"));
      return false;
    } finally {
      setBusyId(null);
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

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(claudeCodeSnippet);
      setSnippetCopied(true);
    } catch {
      setSnippetCopied(false);
    }
  }

  if (hidden) return null;

  return (
    <div className="px-5 py-4">
      {confirmDialogEl}
      <div className="flex items-center gap-1.5 pb-2 text-caption font-medium uppercase tracking-wide text-faint">
        <KeyRound size={13} /> API Key
      </div>

      {err && (
        <Alert tone="danger" className="mb-2 text-meta">
          {err}
        </Alert>
      )}

      {justCreated && (
        <Alert tone="warning" className="mb-3 flex flex-col gap-2 text-meta">
          <span>请立即复制并妥善保存,关闭后将无法再次查看完整密钥。</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-bg px-2 py-1 font-mono text-meta text-fg">
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
          placeholder="新密钥名称(如 my-cli)"
          maxLength={64}
          className="h-auto bg-bg px-3 py-2 text-section"
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
        <div className="flex items-center justify-center gap-2 py-4 text-body text-faint">
          <Spinner /> 加载中…
        </div>
      ) : !keys || keys.length === 0 ? (
        <p className="py-3 text-center text-meta text-faint">还没有 API Key</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="api-keys-list">
          {keys.map((k) => (
            <ApiKeyRow
              key={k.id}
              k={k}
              busy={busyId === k.id}
              onPatch={(p) => patch(k.id, p)}
              onRemove={() => remove(k.id)}
            />
          ))}
        </ul>
      )}

      <details className="mt-3 border-t border-border pt-2 text-caption">
        <summary className="cursor-pointer text-muted">接入本地 Claude Code(Cursor 系模型)</summary>
        <p className="mt-2 text-faint">
          在本机终端设置以下环境变量后启动 <code className="font-mono">claude</code>
          。请求经本站 API Key 端点转发到 Cursor,按站内积分计费(余额为 0 或触达单 key 上限时返回
          402)。
        </p>
        <div className="mt-2 flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-caption text-fg">
            {claudeCodeSnippet}
          </pre>
          <Button variant="secondary" size="sm" onClick={copySnippet} className="shrink-0">
            <Copy size={13} /> {snippetCopied ? "已复制" : "复制"}
          </Button>
        </div>
        <p className="mt-2 text-faint">
          可用模型:<code className="font-mono">cursor-fable-5.1</code> /{" "}
          <code className="font-mono">cursor-opus-5</code> /{" "}
          <code className="font-mono">cursor-opus-4.8</code> /{" "}
          <code className="font-mono">cursor-sonnet-5</code> /{" "}
          <code className="font-mono">cursor-grok-4.6</code> /{" "}
          <code className="font-mono">cursor-gemini-3.8-flash</code>,后缀为思考档位{" "}
          <code className="font-mono">-low</code> / <code className="font-mono">-medium</code> /{" "}
          <code className="font-mono">-high</code> / <code className="font-mono">-xhigh</code> /{" "}
          <code className="font-mono">-max</code>(部分家族不含全部档位),再加{" "}
          <code className="font-mono">-fast</code>{" "}
          为加速版、双倍计费。具体以模型列表中已启用的为准。
        </p>
      </details>
    </div>
  );
}

/** 上限进度百分比(0..100,字符串大数用 BigInt 精确算,非法项当 0)。 */
export function limitPercent(spent: string, limit: string | null): number | null {
  if (limit === null || !/^\d+$/.test(limit) || !/^\d+$/.test(spent)) return null;
  const l = BigInt(limit);
  if (l <= 0n) return null;
  const pct = (BigInt(spent) * 100n) / l;
  return pct > 100n ? 100 : Number(pct);
}

function ApiKeyRow({
  k,
  busy,
  onPatch,
  onRemove,
}: {
  k: ApiKeySummary;
  busy: boolean;
  onPatch: (p: ApiKeyPatch) => Promise<boolean>;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<"label" | "limit" | null>(null);
  const [draft, setDraft] = useState("");
  const disabled = k.disabledAt !== null;
  const pct = limitPercent(k.spentCredits, k.creditLimit);
  const tone = pct === null ? "neutral" : pct >= 100 ? "danger" : pct >= 80 ? "warning" : "brand";

  function startEdit(kind: "label" | "limit") {
    setDraft(kind === "label" ? k.label : (k.creditLimit ?? ""));
    setEditing(kind);
  }

  async function commit() {
    if (editing === "label") {
      const v = draft.trim();
      if (!v || v === k.label) return setEditing(null);
      if (await onPatch({ label: v })) setEditing(null);
      return;
    }
    if (editing === "limit") {
      const v = draft.trim();
      if (v === (k.creditLimit ?? "")) return setEditing(null);
      if (v !== "" && !/^[1-9][0-9]{0,18}$/.test(v)) return;
      if (await onPatch({ creditLimit: v === "" ? null : v })) setEditing(null);
    }
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-lg px-2 py-2 hover:bg-hover",
        disabled && "opacity-60",
      )}
      data-api-key-id={k.id}
    >
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          {editing === "label" ? (
            <span className="flex items-center gap-1">
              <Input
                autoFocus
                value={draft}
                maxLength={80}
                aria-label="密钥名称"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setEditing(null);
                }}
                className="h-7 bg-bg px-2 py-0.5 text-section"
              />
              <IconBtn label="保存" onClick={commit} disabled={busy}>
                <Check size={14} />
              </IconBtn>
              <IconBtn label="取消" onClick={() => setEditing(null)}>
                <X size={14} />
              </IconBtn>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="truncate text-section text-fg">{k.label}</span>
              <IconBtn label="重命名" onClick={() => startEdit("label")} disabled={busy}>
                <Pencil size={12} />
              </IconBtn>
              {disabled && (
                <span className="rounded bg-warning-soft px-1.5 py-0.5 text-caption text-warning">
                  已禁用
                </span>
              )}
            </span>
          )}
          <span className="block truncate font-mono text-caption text-faint">
            {k.keyPrefix}··· · {shortTime(k.createdAt)}
            {k.lastUsedAt ? ` · 最近使用 ${shortTime(k.lastUsedAt)}` : " · 从未使用"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-faint">
          <span>{disabled ? "已停用" : "启用"}</span>
          <Switch
            aria-label={disabled ? "启用该密钥" : "禁用该密钥"}
            checked={!disabled}
            disabled={busy}
            onCheckedChange={(on) => void onPatch({ disabled: !on })}
          />
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="撤销"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 text-caption text-faint">
        <span className="shrink-0 tabular-nums">已用 {formatCredits(k.spentCredits)} 积分</span>
        {editing === "limit" ? (
          <span className="flex items-center gap-1">
            <span>/ 上限</span>
            <Input
              autoFocus
              inputMode="numeric"
              value={draft}
              aria-label="积分上限(留空为不限)"
              placeholder="不限"
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(null);
              }}
              className="h-6 w-28 bg-bg px-2 py-0 text-caption"
            />
            <IconBtn label="保存上限" onClick={commit} disabled={busy}>
              <Check size={13} />
            </IconBtn>
            <IconBtn label="取消" onClick={() => setEditing(null)}>
              <X size={13} />
            </IconBtn>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => startEdit("limit")}
            disabled={busy}
            className="rounded px-1 text-caption text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {k.creditLimit === null ? "设置上限" : `/ 上限 ${formatCredits(k.creditLimit)}`}
          </button>
        )}
        {pct !== null && (
          <Progress
            value={pct}
            tone={tone}
            aria-label={`已用 ${pct}%`}
            className="ml-auto h-1.5 w-24"
          />
        )}
      </div>
    </li>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {children}
    </button>
  );
}
