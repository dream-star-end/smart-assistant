import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  PauseCircle,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import type {
  AuthSession,
  SitesSummaryResponse,
  UserSiteItem,
  UserSiteVisibility,
} from "../../lib/types";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  ListGroup,
  ListSkeleton,
  PanelHeader,
  Select,
  Switch,
  TimeAgo,
  useConfirm,
  useToast,
} from "../ui";

const VISIBILITY_OPTIONS: { value: UserSiteVisibility; label: string }[] = [
  { value: "public", label: "公开访问" },
  { value: "password", label: "口令保护" },
  { value: "disabled", label: "暂停下线" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function visibilityBadge(v: UserSiteVisibility): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (v === "public") return { label: "公开", tone: "success" };
  if (v === "password") return { label: "口令保护", tone: "warning" };
  return { label: "已下线", tone: "neutral" };
}

export function SitesPanel({
  auth,
  onAskInChat,
}: {
  auth: AuthSession;
  onAskInChat?: (text: string) => void;
}) {
  const [summary, setSummary] = useState<SitesSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editVisibility, setEditVisibility] = useState<UserSiteVisibility>("public");
  const [editPassword, setEditPassword] = useState("");
  const [editSpaMode, setEditSpaMode] = useState(true);
  const [saving, setSaving] = useState(false);

  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listSites(auth)
      .then((res) => {
        if (alive) setSummary(res);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载站点列表失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reloadKey]);

  const refresh = useCallback(() => setReloadKey((n) => n + 1), []);

  const openEditor = useCallback(
    (site: UserSiteItem) => {
      if (editingSlug === site.slug) {
        setEditingSlug(null);
        return;
      }
      setEditingSlug(site.slug);
      setEditTitle(site.title);
      setEditVisibility(site.visibility);
      setEditPassword("");
      setEditSpaMode(site.spaMode);
    },
    [editingSlug],
  );

  const copyUrl = useCallback(
    async (site: UserSiteItem) => {
      try {
        await navigator.clipboard?.writeText(site.url);
        setCopiedSlug(site.slug);
        toast("已复制站点链接", "success");
        setTimeout(() => {
          setCopiedSlug((cur) => (cur === site.slug ? null : cur));
        }, 1800);
      } catch {
        toast("复制失败，请手动复制链接", "error");
      }
    },
    [toast],
  );

  const handleSave = useCallback(
    async (e: FormEvent, site: UserSiteItem) => {
      e.preventDefault();
      if (editVisibility === "password" && site.visibility !== "password" && editPassword.length < 4) {
        toast("切换到口令保护模式需填写至少 4 位口令", "error");
        return;
      }
      if (editPassword.length > 0 && editPassword.length < 4) {
        toast("访问口令至少需要 4 位字符", "error");
        return;
      }
      setSaving(true);
      try {
        const patch: {
          title?: string;
          visibility?: UserSiteVisibility;
          password?: string;
          spaMode?: boolean;
        } = {
          title: editTitle.trim() || site.slug,
          visibility: editVisibility,
          spaMode: editSpaMode,
        };
        if (editVisibility === "password" && editPassword.length > 0) {
          patch.password = editPassword;
        }
        const { site: updated } = await api.updateSite(auth, site.slug, patch);
        setSummary((cur) =>
          cur
            ? { ...cur, sites: cur.sites.map((item) => (item.slug === updated.slug ? updated : item)) }
            : cur,
        );
        setEditingSlug(null);
        setEditPassword("");
        toast(`已更新站点「${updated.title || updated.slug}」`, "success");
      } catch (errVal) {
        toast(apiErrorMessage(errVal, "保存站点设置失败"), "error");
      } finally {
        setSaving(false);
      }
    },
    [auth, editPassword, editSpaMode, editTitle, editVisibility, toast],
  );

  const handleDelete = useCallback(
    async (site: UserSiteItem) => {
      const ok = await confirmDialog({
        title: `删除站点「${site.title || site.slug}」？`,
        body: `删除后 ${site.url} 将立即停止访问且不可恢复。`,
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteSite(auth, site.slug);
        setSummary((cur) =>
          cur ? { ...cur, sites: cur.sites.filter((item) => item.slug !== site.slug) } : cur,
        );
        if (editingSlug === site.slug) setEditingSlug(null);
        toast(`已删除站点「${site.title || site.slug}」`, "success");
      } catch (errVal) {
        toast(apiErrorMessage(errVal, "删除站点失败"), "error");
      }
    },
    [auth, confirmDialog, editingSlug, toast],
  );

  const askPrompt = "帮我创建一个网站并发布到持久化域名";

  return (
    <div className="space-y-4 px-4 pt-2 md:px-4">
      <PanelHeader
        title="持久化站点"
        hint={
          summary?.enabled
            ? `站点托管在 *.${summary.baseDomain}，最多可发布 ${summary.maxPerUser} 个站点。`
            : "将 AI 构建的静态网页或 Supabase 前端应用持久托管到公网域名。"
        }
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={refresh} aria-label="刷新站点列表">
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
              刷新
            </Button>
            {onAskInChat && (
              <Button variant="primary" size="sm" onClick={() => onAskInChat(askPrompt)}>
                新建站点
              </Button>
            )}
          </div>
        }
      />

      {loading && <ListSkeleton rows={3} />}

      {!loading && err && (
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={refresh}>
              重试
            </Button>
          }
        >
          {err}
        </Alert>
      )}

      {!loading && !err && summary && !summary.enabled && (
        <EmptyState
          icon={Globe}
          title="持久化站点托管暂未开启"
          hint="当前服务尚未配置站点托管边缘节点与域名密钥。"
        />
      )}

      {!loading && !err && summary?.enabled && summary.sites.length === 0 && (
        <EmptyState
          icon={Globe}
          title="还没有已发布的网站"
          hint={`在对话里让助手制作网页或前端 + Supabase 全栈应用，即可一键发布到 *.${summary.baseDomain} 并长期在线。`}
          action={
            onAskInChat ? (
              <Button variant="primary" onClick={() => onAskInChat(askPrompt)}>
                在对话中创建网站
              </Button>
            ) : undefined
          }
        />
      )}

      {!loading && !err && summary?.enabled && summary.sites.length > 0 && (
        <ListGroup>
          {summary.sites.map((site) => {
            const badge = visibilityBadge(site.visibility);
            const isEditing = editingSlug === site.slug;
            const VisibilityIcon =
              site.visibility === "password"
                ? Lock
                : site.visibility === "disabled"
                  ? PauseCircle
                  : Globe;

            return (
              <div key={site.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <VisibilityIcon
                        size={15}
                        strokeWidth={1.75}
                        aria-hidden="true"
                        className="shrink-0 text-muted"
                      />
                      <span className="truncate text-body font-medium text-fg">
                        {site.title || site.slug}
                      </span>
                      <Badge tone={badge.tone} size="sm">
                        {badge.label}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-muted">
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-accent hover:underline"
                      >
                        {site.url}
                        <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                      </a>
                      <span>{site.fileCount} 个文件</span>
                      <span>{formatBytes(site.sizeBytes)}</span>
                      <span>{site.spaMode ? "SPA 路由" : "多页静态"}</span>
                      <TimeAgo value={site.lastPublishedAt} />
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void copyUrl(site)}
                      aria-label={`复制「${site.title || site.slug}」链接`}
                    >
                      {copiedSlug === site.slug ? (
                        <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                      ) : (
                        <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
                      )}
                      {copiedSlug === site.slug ? "已复制" : "复制"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditor(site)}
                      aria-expanded={isEditing}
                      aria-label={`管理「${site.title || site.slug}」`}
                    >
                      <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
                      管理
                    </Button>
                  </div>
                </div>

                {isEditing && (
                  <form
                    onSubmit={(e) => void handleSave(e, site)}
                    className="mt-3 space-y-3 rounded-lg border border-border bg-bg-subtle p-3"
                  >
                    <div className="grid gap-3 md:grid-cols-2">
                      <Field label="站点标题" htmlFor={`site-title-${site.slug}`}>
                        <Input
                          id={`site-title-${site.slug}`}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          placeholder={site.slug}
                          maxLength={80}
                        />
                      </Field>

                      <Field label="访问权限" htmlFor={`site-vis-${site.slug}`}>
                        <Select
                          id={`site-vis-${site.slug}`}
                          value={editVisibility}
                          onValueChange={(v) => setEditVisibility(v as UserSiteVisibility)}
                          options={VISIBILITY_OPTIONS}
                        />
                      </Field>
                    </div>

                    {editVisibility === "password" && (
                      <Field
                        label="访问口令"
                        htmlFor={`site-pw-${site.slug}`}
                        hint={
                          site.visibility === "password"
                            ? "留空则保留原口令；填写新口令将立即使旧访问 Cookie 失效。"
                            : "访客需输入此口令解锁网站（4–128 位）。"
                        }
                      >
                        <Input
                          id={`site-pw-${site.slug}`}
                          type="password"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          placeholder={
                            site.visibility === "password" ? "留空保持原口令" : "设置 4–128 位访问口令"
                          }
                          maxLength={128}
                        />
                      </Field>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <label className="flex cursor-pointer items-center gap-2 text-body text-fg">
                        <Switch
                          checked={editSpaMode}
                          onCheckedChange={setEditSpaMode}
                          aria-label={`单页应用路由回退「${site.title || site.slug}」`}
                        />
                        <span>单页应用路由回退 (SPA)</span>
                      </label>

                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDelete(site)}
                          className="text-danger hover:text-danger"
                        >
                          <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                          删除站点
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setEditingSlug(null)}>
                          取消
                        </Button>
                        <Button type="submit" variant="primary" size="sm" loading={saving}>
                          保存修改
                        </Button>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </ListGroup>
      )}

      {confirmDialogEl}
    </div>
  );
}
