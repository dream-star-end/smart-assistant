import { Check, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import {
  connectorCapabilityLabel,
  connectorErrorText,
  connectorIcon,
  connectorNeedsRelink,
  type ConnectorConnection,
  type ConnectorFormField,
  type ConnectorProvider,
  type ConnectorsResponse,
} from "../../lib/connectors";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, IconButton, Input, Modal, Spinner, useConfirm } from "../ui";

/** 把 ApiError 的机器码映射为中文（无码/未知码回退通用文案，绝不裸露码）。 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code) return connectorErrorText(e.code);
  return (e as Error)?.message || fallback;
}

/** oauth2_byoa provider 未下发 formFields 时的兜底字段（契约 body 键 clientId/clientSecret）。 */
const DEFAULT_OAUTH_FIELDS: ConnectorFormField[] = [
  { key: "clientId", label: "Client ID", type: "text", required: true },
  { key: "clientSecret", label: "Client Secret", type: "password", required: true },
];

/**
 * 应用连接器 Tab：provider 目录（图标/描述/读写能力/绑定状态）+ formFields 驱动的绑定
 * 弹层（token/basic 表单 · BYOA OAuth 先填 client 凭据再整页跳授权）+ 已绑多账号列表
 * （行内改备注名 / RELINK 引导 / 解绑二次确认）。
 *
 * 目录与已绑列表都以 GET /api/connectors 为唯一权威；任何变更（绑定/解绑/改名）后
 * 整体 reload，不做本地乐观拼接。github 绑定跳转现有 GitHub OAuth（api.startGithubOAuth）。
 */
export function ConnectorsTab({ auth }: { auth: AuthSession }) {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 打开绑定弹层的 provider（github 不走弹层，直接跳 OAuth）。 */
  const [bindFor, setBindFor] = useState<ConnectorProvider | null>(null);
  const [confirm, confirmEl] = useConfirm();

  const reload = useCallback(() => {
    let alive = true;
    setErr(null);
    api
      .getConnectors(auth)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setErr(errText(e, "加载应用连接失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  useEffect(() => reload(), [reload]);

  /** provider id → 已绑连接（多账号多行）。 */
  const connsByProvider = useMemo(() => {
    const m = new Map<string, ConnectorConnection[]>();
    for (const c of data?.connections ?? []) {
      const list = m.get(c.provider) ?? [];
      list.push(c);
      m.set(c.provider, list);
    }
    return m;
  }, [data]);

  const startBind = useCallback(
    (p: ConnectorProvider) => {
      if (p.id === "github") {
        // GitHub 复用现有账号 OAuth 绑定入口（v1 只读，凭据权威在 github_links）。
        api
          .startGithubOAuth(auth)
          .then((r) => {
            window.location.href = r.authorizeUrl;
          })
          .catch((e) => setErr(errText(e, "发起 GitHub 授权失败")));
        return;
      }
      setBindFor(p);
    },
    [auth],
  );

  const unbind = useCallback(
    async (conn: ConnectorConnection) => {
      const name = conn.displayName || conn.accountHint || conn.provider;
      const ok = await confirm({
        title: `解绑「${name}」?`,
        body: "解绑后 AI 助手将立即无法访问该账号，凭据会被销毁。此操作不可撤销。",
        confirmText: "解绑",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteConnector(auth, conn.id);
        reload();
      } catch (e) {
        setErr(errText(e, "解绑失败"));
      }
    },
    [auth, confirm, reload],
  );

  const rename = useCallback(
    async (conn: ConnectorConnection, displayName: string) => {
      try {
        await api.renameConnector(auth, conn.id, displayName);
        reload();
      } catch (e) {
        setErr(errText(e, "重命名失败"));
      }
    },
    [auth, reload],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载应用连接…
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-4">
        <p className="text-[12.5px] leading-relaxed text-faint">
          绑定你的应用账号后，AI 助手即可在对话中访问这些应用；所有写入类操作（发邮件、
          上传文件等）都会先在对话里向你逐次确认，未经确认不会执行。
        </p>
        {err && (
          <Alert tone="danger" className="mt-3 text-[12.5px]">
            {err}
          </Alert>
        )}
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        {(data?.providers ?? []).map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            connections={connsByProvider.get(p.id) ?? []}
            onBind={() => startBind(p)}
            onUnbind={unbind}
            onRename={rename}
          />
        ))}
        {data && data.providers.length === 0 && (
          <p className="py-6 text-center text-[13px] text-faint">暂无可绑定的应用。</p>
        )}
      </div>

      <BindDialog
        auth={auth}
        provider={bindFor}
        onClose={() => setBindFor(null)}
        onBound={() => {
          setBindFor(null);
          reload();
        }}
      />
      {confirmEl}
    </div>
  );
}

// ── provider 目录卡（含该 provider 的已绑多账号列表） ────────────────────────

function ProviderCard({
  provider,
  connections,
  onBind,
  onUnbind,
  onRename,
}: {
  provider: ConnectorProvider;
  connections: ConnectorConnection[];
  onBind: () => void;
  onUnbind: (conn: ConnectorConnection) => void;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
}) {
  const Icon = connectorIcon(provider.id);
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium text-fg">{provider.label}</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-muted">
              {connectorCapabilityLabel(provider.id)}
            </span>
            {connections.length > 0 && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                已绑定 {connections.length} 个账号
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-faint">{provider.description}</p>
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={onBind}>
          {connections.length > 0 ? "添加账号" : "绑定"}
        </Button>
      </div>

      {connections.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border border-t border-border pt-1">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              conn={c}
              onUnbind={onUnbind}
              onRename={onRename}
              onRelink={onBind}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 已绑连接行（备注名行内编辑 / 状态 / RELINK 引导 / 解绑） ──────────────────

function ConnectionRow({
  conn,
  onUnbind,
  onRename,
  onRelink,
}: {
  conn: ConnectorConnection;
  onUnbind: (conn: ConnectorConnection) => void;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
  onRelink: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conn.displayName);
  const needsRelink = connectorNeedsRelink(conn);
  const hasError = conn.status === "error";

  const save = () => {
    setEditing(false);
    const next = name.trim();
    if (next !== conn.displayName) onRename(conn, next);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              aria-label="备注名"
              className="h-8 max-w-56 md:text-[13px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") {
                  setName(conn.displayName);
                  setEditing(false);
                }
              }}
              // biome-ignore lint/a11y/noAutofocus: 行内编辑开启即聚焦是预期交互
              autoFocus
            />
            <IconButton size="sm" aria-label="保存备注名" onClick={save}>
              <Check size={14} />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="取消编辑"
              onClick={() => {
                setName(conn.displayName);
                setEditing(false);
              }}
            >
              <X size={14} />
            </IconButton>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] text-fg">
              {conn.displayName || conn.accountHint || "未命名连接"}
            </span>
            <IconButton size="sm" aria-label="编辑备注名" onClick={() => setEditing(true)}>
              <Pencil size={13} />
            </IconButton>
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
          {conn.accountHint && <span className="truncate">{conn.accountHint}</span>}
          {!hasError && <span className="text-success">正常</span>}
          {needsRelink && <span className="text-warning">需要重新绑定</span>}
          {hasError && !needsRelink && (
            <span className="text-danger">{connectorErrorText(conn.lastErrorCode)}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {needsRelink && (
          <Button variant="secondary" size="sm" onClick={onRelink}>
            重新绑定
          </Button>
        )}
        <IconButton
          size="sm"
          aria-label="解绑"
          className="text-danger"
          onClick={() => onUnbind(conn)}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
    </li>
  );
}

// ── 绑定弹层（formFields 驱动；token/basic 直落库，BYOA OAuth 整页跳授权） ────

function BindDialog({
  auth,
  provider,
  onClose,
  onBound,
}: {
  auth: AuthSession;
  provider: ConnectorProvider | null;
  onClose: () => void;
  onBound: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 换 provider / 重开弹层 → 重置表单瞬态（凭据绝不跨 provider 残留）。
  useEffect(() => {
    setValues({});
    setDisplayName("");
    setErr(null);
    setSubmitting(false);
  }, [provider?.id]);

  const isOauth = provider?.authKind === "oauth2_byoa";
  const fields: ConnectorFormField[] =
    provider == null
      ? []
      : provider.formFields.length > 0
        ? provider.formFields
        : isOauth
          ? DEFAULT_OAUTH_FIELDS
          : [];

  const missingRequired = fields.some((f) => f.required && !(values[f.key] ?? "").trim());
  /** 顶部引导（helpText/helpUrl，如「如何获取 QQ 邮箱授权码」）。 */
  const helps = fields.filter((f) => f.helpText || f.helpUrl);

  const submit = async () => {
    if (!provider || submitting || missingRequired) return;
    setSubmitting(true);
    setErr(null);
    const trimmed: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.key] ?? "").trim();
      if (v) trimmed[f.key] = v;
    }
    const dn = displayName.trim() || undefined;
    try {
      if (isOauth) {
        const r = await api.startConnectorOAuth(auth, provider.id, {
          clientId: trimmed.clientId ?? "",
          clientSecret: trimmed.clientSecret ?? "",
          displayName: dn,
        });
        // 整页跳转授权页；回跳 /?connector_linked=<provider> 由 App 层 toast。
        window.location.href = r.authorizeUrl;
        return; // 跳转中，不再触发本地状态更新
      }
      await api.bindConnector(auth, provider.id, { fields: trimmed, displayName: dn });
      onBound();
    } catch (e) {
      setErr(errText(e, "绑定失败，请重试"));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={provider != null}
      onOpenChange={(o) => !o && onClose()}
      title={provider ? `绑定 ${provider.label}` : undefined}
      description={
        isOauth
          ? "填写你的自建应用凭据，前往授权后即可完成绑定。"
          : "凭据仅用于服务端加密存储，不会进入对话。"
      }
      footer={
        provider && (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={submitting || missingRequired}
              onClick={() => void submit()}
            >
              {submitting ? "提交中…" : isOauth ? "前往授权" : "绑定"}
            </Button>
          </>
        )
      }
    >
      {provider && (
        <div className="flex flex-col gap-3">
          {helps.length > 0 && (
            <div className="rounded-lg bg-hover px-3 py-2.5">
              {helps.map((f) => (
                <div key={f.key} className="text-[12px] leading-relaxed text-muted">
                  {f.helpText}
                  {f.helpUrl && (
                    <a
                      href={f.helpUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline"
                    >
                      查看指引
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {err && (
            <Alert tone="danger" className="text-[12.5px]">
              {err}
            </Alert>
          )}

          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[12.5px] text-muted">
                {f.label}
                {f.required && <span className="ml-0.5 text-danger">*</span>}
              </span>
              <Input
                type={f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}
                value={values[f.key] ?? ""}
                placeholder={f.placeholder}
                autoComplete="off"
                onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            </label>
          ))}

          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] text-muted">备注名（可选）</span>
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作邮箱"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
