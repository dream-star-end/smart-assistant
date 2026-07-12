import { Check, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, apiErrorMessage } from "../../lib/api";
import {
  bindFieldMeta,
  connectorCapabilityLabel,
  connectorErrorText,
  connectorIcon,
  connectorNeedsRelink,
  declarativeCapabilityLabel,
  isOauthAuthMode,
  type ConnectorConnection,
  type ConnectorFormField,
  type ConnectorProvider,
  type ConnectorsResponse,
  type DeclarativeCatalogEntry,
  type DeclarativeCatalogResponse,
  type DeclarativeConnection,
  type DeclarativeConnectionsResponse,
} from "../../lib/connectors";
import type { AuthSession } from "../../lib/types";
import { Alert, Button, IconButton, Input, Modal, Spinner, useConfirm } from "../ui";

/** 把 ApiError 的机器码映射为中文（无码/未知码走 apiErrorMessage 收口：后端中文直显、
 *  英文/技术串回退 fallback + 追踪号，绝不裸露码或英文原文）。 */
function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code) return connectorErrorText(e.code);
  return apiErrorMessage(e, fallback);
}

/** oauth2_byoa provider 未下发 formFields 时的兜底字段（契约 body 键 clientId/clientSecret）。 */
const DEFAULT_OAUTH_FIELDS: ConnectorFormField[] = [
  { key: "clientId", label: "Client ID", type: "text", required: true },
  { key: "clientSecret", label: "Client Secret", type: "password", required: true },
];

/**
 * 统一连接器卡片模型：把 v1 手写 provider 与声明式 connector 归一到同一套渲染契约。
 * system 决定绑定/解绑/能力标注走哪一套后端，slug 是去重键（声明式优先）。
 */
type UnifiedProvider =
  | { system: "v1"; slug: string; label: string; description: string; v1: ConnectorProvider }
  | {
      system: "declarative";
      slug: string;
      label: string;
      description: string;
      decl: DeclarativeCatalogEntry;
    };

/**
 * 应用连接器 Tab：统一展示 **v1 手写 provider** + **声明式 connector** 两套后端。
 * 同一列表里按 slug 去重（同 slug 两边都有 → 只显示声明式版，因其是权威且带
 * allowlist+pin）。绑定/解绑按卡片 system 路由：
 *   - v1：formFields 弹层（token/basic）· BYOA OAuth 整页跳转 · github 复用账号 OAuth；
 *   - 声明式：requiredBindSources 驱动的 DeclarativeBindDialog。
 *
 * v1 目录（GET /api/connectors）是硬依赖，失败 → 整体报错；声明式（catalog +
 * connections）是增量，任一失败各自降级为空，**绝不阻断 v1 现有能力**。任何变更后
 * 整体 reload，不做本地乐观拼接。
 */
export function ConnectorsTab({ auth }: { auth: AuthSession }) {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [declCatalog, setDeclCatalog] = useState<DeclarativeCatalogEntry[]>([]);
  const [declConnections, setDeclConnections] = useState<DeclarativeConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /** 打开 v1 绑定弹层的 provider（github 不走弹层，直接跳 OAuth）。 */
  const [bindFor, setBindFor] = useState<ConnectorProvider | null>(null);
  /** 打开声明式绑定弹层的 catalog 条目。 */
  const [bindDeclFor, setBindDeclFor] = useState<DeclarativeCatalogEntry | null>(null);
  const [confirm, confirmEl] = useConfirm();

  const reload = useCallback(() => {
    let alive = true;
    setErr(null);
    // 声明式是增量：各自 catch 降级为空，永不 reject 到 Promise.all；只有 v1 会阻断。
    const catalogP: Promise<DeclarativeCatalogResponse> = api
      .getDeclarativeCatalog(auth)
      .catch((e) => {
        console.warn("[connectors] 声明式目录加载失败，降级仅显示 v1 连接器", e);
        return { connectors: [] };
      });
    const connsP: Promise<DeclarativeConnectionsResponse> = api
      .getDeclarativeConnections(auth)
      .catch((e) => {
        console.warn("[connectors] 声明式连接加载失败，降级", e);
        return { connections: [] };
      });
    Promise.all([api.getConnectors(auth), catalogP, connsP])
      .then(([d, cat, cn]) => {
        if (!alive) return;
        setData(d);
        setDeclCatalog(cat.connectors);
        setDeclConnections(cn.connections);
      })
      .catch((e) => {
        // 仅 v1 会 reject 到此（声明式已各自 catch 降级）。
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

  /** slug 去重、声明式优先，合并成统一卡片列表（声明式在前，各自保持插入序，渲染稳定）。 */
  const unified = useMemo<UnifiedProvider[]>(() => {
    const bySlug = new Map<string, UnifiedProvider>();
    for (const c of declCatalog) {
      bySlug.set(c.slug, {
        system: "declarative",
        slug: c.slug,
        label: c.label,
        description: c.description,
        decl: c,
      });
    }
    // v1 provider 仅当该 slug 未被声明式占据时加入（声明式权威，带 allowlist+pin）。
    for (const p of data?.providers ?? []) {
      if (bySlug.has(p.id)) continue;
      bySlug.set(p.id, {
        system: "v1",
        slug: p.id,
        label: p.label,
        description: p.description,
        v1: p,
      });
    }
    const decl: UnifiedProvider[] = [];
    const v1: UnifiedProvider[] = [];
    for (const u of bySlug.values()) (u.system === "declarative" ? decl : v1).push(u);
    return [...decl, ...v1];
  }, [declCatalog, data]);

  /** v1 provider id → 已绑连接（多账号多行，带 status/lastErrorCode）。 */
  const v1ConnsBySlug = useMemo(() => {
    const m = new Map<string, ConnectorConnection[]>();
    for (const c of data?.connections ?? []) {
      const list = m.get(c.provider) ?? [];
      list.push(c);
      m.set(c.provider, list);
    }
    return m;
  }, [data]);

  /** 声明式 slug → 已绑连接（无 status，映射为 active 形状喂给 ConnectionRow）。 */
  const declConnsBySlug = useMemo(() => {
    const m = new Map<string, ConnectorConnection[]>();
    for (const c of declConnections) {
      const list = m.get(c.slug) ?? [];
      list.push({
        id: c.id,
        provider: c.slug,
        displayName: c.displayName,
        accountHint: c.accountHint ?? "",
        status: "active",
        lastErrorCode: null,
        createdAt: c.createdAt,
      });
      m.set(c.slug, list);
    }
    return m;
  }, [declConnections]);

  const startBind = useCallback(
    (u: UnifiedProvider) => {
      if (u.system === "declarative") {
        setBindDeclFor(u.decl);
        return;
      }
      const p = u.v1;
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
    async (u: UnifiedProvider, conn: ConnectorConnection) => {
      const name = conn.displayName || conn.accountHint || conn.provider;
      const ok = await confirm({
        title: `解绑「${name}」?`,
        body: "解绑后 AI 助手将立即无法访问该账号，凭据会被销毁。此操作不可撤销。",
        confirmText: "解绑",
        danger: true,
      });
      if (!ok) return;
      try {
        if (u.system === "declarative") await api.unbindDeclarativeConnector(auth, conn.id);
        else await api.deleteConnector(auth, conn.id);
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
        {unified.map((u) => (
          <ProviderCard
            key={u.slug}
            slug={u.slug}
            label={u.label}
            description={u.description}
            capabilityLabel={
              u.system === "declarative"
                ? declarativeCapabilityLabel(u.decl.actions)
                : connectorCapabilityLabel(u.slug)
            }
            connections={
              u.system === "declarative"
                ? (declConnsBySlug.get(u.slug) ?? [])
                : (v1ConnsBySlug.get(u.slug) ?? [])
            }
            canRename={u.system === "v1"}
            onBind={() => startBind(u)}
            onUnbind={(c) => unbind(u, c)}
            onRename={rename}
          />
        ))}
        {data && unified.length === 0 && (
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
      <DeclarativeBindDialog
        auth={auth}
        entry={bindDeclFor}
        onClose={() => setBindDeclFor(null)}
        onBound={() => {
          setBindDeclFor(null);
          reload();
        }}
      />
      {confirmEl}
    </div>
  );
}

// ── provider 目录卡（含该 provider 的已绑多账号列表） ────────────────────────

function ProviderCard({
  slug,
  label,
  description,
  capabilityLabel,
  connections,
  canRename,
  onBind,
  onUnbind,
  onRename,
}: {
  slug: string;
  label: string;
  description: string;
  capabilityLabel: string;
  connections: ConnectorConnection[];
  canRename: boolean;
  onBind: () => void;
  onUnbind: (conn: ConnectorConnection) => void;
  onRename: (conn: ConnectorConnection, displayName: string) => void;
}) {
  const Icon = connectorIcon(slug);
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-medium text-fg">{label}</span>
            <span className="rounded-full bg-hover px-2 py-0.5 text-[10.5px] text-muted">
              {capabilityLabel}
            </span>
            {connections.length > 0 && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10.5px] text-success">
                已绑定 {connections.length} 个账号
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-faint">{description}</p>
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
              canRename={canRename}
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
  canRename = true,
  onUnbind,
  onRename,
  onRelink,
}: {
  conn: ConnectorConnection;
  /** 是否支持改名（声明式后端无 rename → 传 false 隐藏铅笔与行内编辑）。 */
  canRename?: boolean;
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
            {canRename && (
              <IconButton size="sm" aria-label="编辑备注名" onClick={() => setEditing(true)}>
                <Pencil size={13} />
              </IconButton>
            )}
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

// ── 声明式绑定弹层（requiredBindSources 驱动；直填落库 / oauth2 整页跳授权） ───

/**
 * 声明式连接器绑定弹层：表单字段由 entry.requiredBindSources 驱动，每个 source 经
 * bindFieldMeta 取 label/输入类型（未知 source 回退密码框）。全部必填，另有可选备注名。
 * 凭据仅用于服务端加密存储，绝不进入对话或容器。
 *
 * 按 authMode 分两条提交路径（判定收口于 isOauthAuthMode，禁散写字符串比较）：
 *   - **oauth2-auth-code**：字段即用户 BYOA 自建应用的 client_id/client_secret →
 *     api.startDeclarativeOauth → 整页跳转授权页（后端回跳 /?connector_linked=<slug>
 *     由 App 层 toast）。此模式走直填 bind 会被后端硬拒，故必须走这条。
 *   - 其余（static-token / token-exchange…）：api.bindDeclarativeConnector 直填落库
 *     （secrets 键 = source 名）。
 */
function DeclarativeBindDialog({
  auth,
  entry,
  onClose,
  onBound,
}: {
  auth: AuthSession;
  entry: DeclarativeCatalogEntry | null;
  onClose: () => void;
  onBound: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 换连接器 / 重开弹层 → 重置表单瞬态（凭据绝不跨连接器残留）。
  useEffect(() => {
    setValues({});
    setDisplayName("");
    setErr(null);
    setSubmitting(false);
  }, [entry?.versionId]);

  const isOauth = entry != null && isOauthAuthMode(entry.authMode);
  // 平台已注册 OAuth App → 用户零填写，一键授权（读后端显式字段，不从空数组反推）。
  const isPlatformOauth = isOauth && entry.clientProvisioning === "platform";
  const sources = entry?.requiredBindSources ?? [];
  const missingRequired = sources.some((s) => !(values[s] ?? "").trim());

  const submit = async () => {
    if (!entry || submitting || missingRequired) return;
    setSubmitting(true);
    setErr(null);
    const secrets: Record<string, string> = {};
    for (const s of sources) {
      const v = (values[s] ?? "").trim();
      if (v) secrets[s] = v;
    }
    const dn = displayName.trim() || undefined;
    try {
      if (isOauth) {
        // 键 = 后端下发的 source 名（client_id / client_secret），非 camelCase。
        const r = await api.startDeclarativeOauth(auth, {
          versionId: entry.versionId,
          clientId: secrets.client_id ?? "",
          clientSecret: secrets.client_secret ?? "",
          displayName: dn,
        });
        // 整页跳转授权页；回跳 /?connector_linked=<slug> 由 App 层 toast。
        window.location.href = r.authorizeUrl;
        return; // 跳转中，不再触发本地状态更新
      }
      await api.bindDeclarativeConnector(auth, {
        versionId: entry.versionId,
        secrets,
        displayName: dn,
      });
      onBound();
    } catch (e) {
      setErr(errText(e, isOauth ? "发起授权失败，请重试" : "绑定失败，请重试"));
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={entry != null}
      onOpenChange={(o) => !o && onClose()}
      title={entry ? `绑定 ${entry.label}` : undefined}
      description={
        isPlatformOauth
          ? "无需填写任何凭据，点击前往授权即可完成绑定。"
          : isOauth
            ? "填写你的自建应用凭据，前往授权后即可完成绑定。"
            : "凭据仅用于服务端加密存储，绝不会进入对话或容器。"
      }
      footer={
        entry && (
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
      {entry && (
        <div className="flex flex-col gap-3">
          {err && (
            <Alert tone="danger" className="text-[12.5px]">
              {err}
            </Alert>
          )}

          {sources.map((s) => {
            const meta = bindFieldMeta(s);
            return (
              <label key={s} className="flex flex-col gap-1">
                <span className="text-[12.5px] text-muted">
                  {meta.label}
                  <span className="ml-0.5 text-danger">*</span>
                </span>
                <Input
                  type={meta.type === "password" ? "password" : "text"}
                  value={values[s] ?? ""}
                  placeholder={meta.placeholder}
                  autoComplete="off"
                  onChange={(e) => setValues((prev) => ({ ...prev, [s]: e.target.value }))}
                />
              </label>
            );
          })}

          <label className="flex flex-col gap-1">
            <span className="text-[12.5px] text-muted">备注名（可选）</span>
            <Input
              value={displayName}
              maxLength={64}
              placeholder="如：工作账号"
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
