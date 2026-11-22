import {
  Check,
  Copy,
  Link2,
  LogOut,
  Shield,
  Terminal,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../../lib/api";
import {
  type SiteCollaboratorItem,
  type SiteInviteItem,
  sitesApi,
} from "../../lib/sitesApi";
import type {
  AuthSession,
  UserSiteCollaboratorRole,
  UserSiteItem,
} from "../../lib/types";
import {
  Alert,
  Button,
  IconButton,
  Input,
  Select,
  Skeleton,
  useConfirm,
  useToast,
} from "../ui";

const ROLE_OPTIONS: { value: UserSiteCollaboratorRole; label: string }[] = [
  { value: "editor", label: "可编辑开发" },
  { value: "viewer", label: "仅查看" },
];

const EXPIRY_OPTIONS: { value: string; label: string; hours: number | null }[] = [
  { value: "24", label: "24 小时有效", hours: 24 },
  { value: "168", label: "7 天有效", hours: 168 },
  { value: "720", label: "30 天有效", hours: 720 },
  { value: "never", label: "永不过期", hours: null },
];

const MAX_USES_OPTIONS: { value: string; label: string; maxUses: number | null }[] = [
  { value: "unlimited", label: "不限次数", maxUses: null },
  { value: "1", label: "仅限 1 次", maxUses: 1 },
  { value: "5", label: "最多 5 次", maxUses: 5 },
  { value: "20", label: "最多 20 次", maxUses: 20 },
];

function formatDateTime(iso: string | null): string {
  if (!iso) return "永不过期";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function roleLabel(role: "owner" | "editor" | "viewer"): string {
  if (role === "owner") return "所有者";
  if (role === "editor") return "可编辑开发";
  return "仅查看";
}

export function SiteShareTab({
  auth,
  site,
  readOnly = false,
  onCollaboratorCountChange,
  onLeftSite,
}: {
  auth: AuthSession;
  site: UserSiteItem;
  readOnly?: boolean;
  onCollaboratorCountChange?: (count: number) => void;
  onLeftSite?: (slug: string) => void;
}) {
  const toast = useToast();
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const mountedRef = useRef(true);
  const genRef = useRef(0);
  const onCollaboratorCountChangeRef = useRef(onCollaboratorCountChange);
  onCollaboratorCountChangeRef.current = onCollaboratorCountChange;

  const isOwner = (site.accessRole ?? "owner") === "owner";

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<SiteCollaboratorItem[]>([]);
  const [invites, setInvites] = useState<SiteInviteItem[]>([]);

  // Add collaborator by email
  const [emailInput, setEmailInput] = useState("");
  const [emailRole, setEmailRole] = useState<UserSiteCollaboratorRole>("editor");
  const [addingEmail, setAddingEmail] = useState(false);

  // Create invite link
  const [inviteRole, setInviteRole] = useState<UserSiteCollaboratorRole>("editor");
  const [inviteExpiry, setInviteExpiry] = useState("168");
  const [inviteMaxUses, setInviteMaxUses] = useState("unlimited");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadSharing = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await sitesApi.getSiteSharing(auth, site.slug);
      if (!mountedRef.current || gen !== genRef.current) return;
      setCollaborators(res.collaborators);
      setInvites(res.invites);
      onCollaboratorCountChangeRef.current?.(res.collaborators.length);
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      setErr(apiErrorMessage(e, "加载站点共享信息失败"));
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setLoading(false);
      }
    }
  }, [auth, site.slug]);

  useEffect(() => {
    setLatestInviteUrl(null);
    setCopiedUrl(false);
    setEmailInput("");
    void loadSharing();
  }, [loadSharing]);

  async function handleAddByEmail(e: FormEvent) {
    e.preventDefault();
    if (!isOwner || readOnly || addingEmail) return;
    const email = emailInput.trim();
    if (!email) return;
    const gen = genRef.current;
    setAddingEmail(true);
    try {
      const res = await sitesApi.addSiteCollaborator(auth, site.slug, {
        email,
        role: emailRole,
      });
      if (!mountedRef.current || gen !== genRef.current) return;
      setCollaborators(res.collaborators);
      onCollaboratorCountChange?.(res.collaborators.length);
      setEmailInput("");
      toast(`已添加协作者 ${res.collaborator.email}`, "success");
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "添加协作者失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setAddingEmail(false);
      }
    }
  }

  async function handleRoleChange(targetUserId: number, role: UserSiteCollaboratorRole) {
    if (!isOwner || readOnly) return;
    const gen = genRef.current;
    setBusyId(`user:${targetUserId}`);
    try {
      const res = await sitesApi.updateSiteCollaborator(auth, site.slug, targetUserId, role);
      if (!mountedRef.current || gen !== genRef.current) return;
      setCollaborators(res.collaborators);
      toast(`已更新角色为「${roleLabel(role)}」`, "success");
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "更新协作者角色失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setBusyId(null);
      }
    }
  }

  async function handleRemoveCollaborator(item: SiteCollaboratorItem) {
    if (!isOwner || readOnly) return;
    const gen = genRef.current;
    const ok = await confirmDialog({
      title: `移除协作者「${item.displayName || item.email}」？`,
      body: "移除后对方将立即失去该站点的访问、拉取与发布权限。",
      confirmText: "移除",
      danger: true,
    });
    if (ok !== true || !mountedRef.current || gen !== genRef.current) return;
    setBusyId(`user:${item.userId}`);
    try {
      const res = await sitesApi.removeSiteCollaborator(auth, site.slug, item.userId);
      if (!mountedRef.current || gen !== genRef.current) return;
      setCollaborators(res.collaborators);
      onCollaboratorCountChange?.(res.collaborators.length);
      toast(`已移除 ${item.email}`, "info");
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "移除协作者失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setBusyId(null);
      }
    }
  }

  async function handleLeaveSite() {
    if (isOwner || leaving) return;
    const gen = genRef.current;
    const ok = await confirmDialog({
      title: `退出站点「${site.title}」的协作？`,
      body: "退出后该站点将从你的「共享给我」列表中移除，如需重新加入需由所有者再次邀请。",
      confirmText: "退出协作",
      danger: true,
    });
    if (ok !== true || !mountedRef.current || gen !== genRef.current) return;
    setLeaving(true);
    try {
      await sitesApi.leaveSite(auth, site.slug);
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(`已退出「${site.title}」协作`, "info");
      onLeftSite?.(site.slug);
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "退出协作失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setLeaving(false);
      }
    }
  }

  async function handleCreateInvite() {
    if (!isOwner || readOnly || creatingInvite) return;
    const gen = genRef.current;
    const expCfg = EXPIRY_OPTIONS.find((x) => x.value === inviteExpiry) ?? EXPIRY_OPTIONS[1]!;
    const maxCfg =
      MAX_USES_OPTIONS.find((x) => x.value === inviteMaxUses) ?? MAX_USES_OPTIONS[0]!;
    setCreatingInvite(true);
    try {
      const res = await sitesApi.createSiteInvite(auth, site.slug, {
        role: inviteRole,
        expiresInHours: expCfg.hours,
        maxUses: maxCfg.maxUses,
      });
      if (!mountedRef.current || gen !== genRef.current) return;
      setInvites(res.invites);
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const fullUrl = `${origin}/sites?siteInvite=${encodeURIComponent(res.token)}`;
      setLatestInviteUrl(fullUrl);
      setCopiedUrl(false);
      toast("邀请链接已生成，请复制发给协作者", "success");
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "生成邀请链接失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setCreatingInvite(false);
      }
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    if (!isOwner || readOnly) return;
    const gen = genRef.current;
    setBusyId(`invite:${inviteId}`);
    try {
      const res = await sitesApi.revokeSiteInvite(auth, site.slug, inviteId);
      if (!mountedRef.current || gen !== genRef.current) return;
      setInvites(res.invites);
      toast("已撤销该邀请链接", "info");
    } catch (e) {
      if (!mountedRef.current || gen !== genRef.current) return;
      toast(apiErrorMessage(e, "撤销邀请链接失败"), "error");
    } finally {
      if (mountedRef.current && gen === genRef.current) {
        setBusyId(null);
      }
    }
  }

  async function copyText(text: string, markUrl = false) {
    try {
      await navigator.clipboard.writeText(text);
      if (markUrl) {
        setCopiedUrl(true);
        setTimeout(() => {
          if (mountedRef.current) setCopiedUrl(false);
        }, 2000);
      }
      toast("已复制到剪贴板", "success");
    } catch {
      toast("复制失败，请手动选中复制", "error");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
      </div>
    );
  }

  if (err) {
    return (
      <Alert tone="danger">
        <div className="flex items-center justify-between gap-3">
          <span>{err}</span>
          <Button size="sm" variant="secondary" onClick={() => void loadSharing()}>
            重试
          </Button>
        </div>
      </Alert>
    );
  }

  const pullCmd = `oc-site pull ${site.slug} ./${site.slug}`;
  const pushCmd = `oc-site publish ./${site.slug} --slug ${site.slug}`;

  return (
    <div className="space-y-6">
      <div className="oc-callout oc-callout-info flex items-start gap-3 rounded-xl px-4 py-3.5 text-caption text-muted">
        <span className="oc-icon-badge oc-icon-badge-info mt-0.5 size-7 rounded-lg" aria-hidden="true">
          <Shield size={14} strokeWidth={1.75} />
        </span>
        <div className="space-y-1">
          <p className="text-meta font-semibold text-fg">协作权限说明</p>
          <p className="leading-relaxed">
            <strong>可编辑开发</strong>：可拉取站点代码（<code className="font-mono">oc-site pull</code>）、使用「实时编辑」批注改码、发布新版、修改标题、查看分析与调试 SQLite。删除站点、更改域名、修改访问口令、管理环境变量密钥及成员权限仅归<strong>所有者</strong>。
          </p>
        </div>
      </div>

      <section className="oc-surface-card space-y-4 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="oc-icon-badge oc-icon-badge-accent size-8 rounded-lg" aria-hidden="true">
              <Users size={15} strokeWidth={1.75} />
            </span>
            <div>
              <h3 className="text-section font-semibold text-fg">
                协作成员（{collaborators.length + 1}）
              </h3>
              <p className="text-caption text-muted">
                {isOwner
                  ? "通过站内注册邮箱直接添加协作者，一起开发维护这个站点"
                  : "查看当前参与该站点协作的成员"}
              </p>
            </div>
          </div>
          {!isOwner && (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full text-danger hover:bg-hover"
              disabled={leaving}
              onClick={() => void handleLeaveSite()}
            >
              <LogOut size={14} aria-hidden="true" />
              {leaving ? "退出中…" : "退出协作"}
            </Button>
          )}
        </div>

        {isOwner && (
          <form
            onSubmit={(e) => void handleAddByEmail(e)}
            className="flex flex-col gap-2.5 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <Input
                type="email"
                value={emailInput}
                disabled={readOnly || addingEmail}
                placeholder="输入对方在本站的注册邮箱，例如 colleague@example.com"
                aria-label="协作者邮箱"
                onChange={(e) => setEmailInput(e.target.value)}
              />
            </div>
            <div className="w-full sm:w-36">
              <Select
                aria-label="协作者权限"
                value={emailRole}
                disabled={readOnly || addingEmail}
                options={ROLE_OPTIONS}
                onValueChange={(val) => setEmailRole(val as UserSiteCollaboratorRole)}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="h-10 shrink-0 rounded-full px-4"
              disabled={readOnly || addingEmail || !emailInput.trim()}
            >
              <UserPlus size={14} aria-hidden="true" />
              {addingEmail ? "添加中…" : "添加协作者"}
            </Button>
          </form>
        )}

        <div className="oc-surface-recessed divide-y divide-border/60 overflow-hidden rounded-xl">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="oc-avatar-ring flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent"
              >
                {(site.ownerDisplayName || site.ownerEmail || "O").trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-fg">
                  {site.ownerDisplayName || site.ownerEmail || "站点所有者"}
                  {isOwner && <span className="ml-1.5 text-caption text-muted">（你）</span>}
                </p>
                {site.ownerEmail && (
                  <p className="truncate text-caption text-muted">{site.ownerEmail}</p>
                )}
              </div>
            </div>
            <span className="oc-badge-craft rounded-full bg-accent-soft px-2.5 py-0.5 text-caption font-medium text-accent">
              所有者
            </span>
          </div>

          {collaborators.length === 0 ? (
            <div className="px-4 py-5 text-center text-body text-muted">
              暂无其他协作者 — {isOwner ? "可通过上方邮箱添加，或在下方生成邀请链接。" : ""}
            </div>
          ) : (
            collaborators.map((member) => {
              const busy = busyId === `user:${member.userId}`;
              const initial = (member.displayName || member.email || "?").trim().charAt(0).toUpperCase();
              return (
                <div
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-hover/40"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="oc-avatar-ring flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-caption font-semibold text-muted"
                    >
                      {initial}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-body font-medium text-fg">
                        {member.displayName || member.email}
                      </p>
                      <p className="truncate text-caption text-muted">{member.email}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isOwner ? (
                      <>
                        <Select
                          aria-label={`${member.email} 权限`}
                          value={member.role}
                          disabled={readOnly || busy}
                          inputSize="sm"
                          className="w-32"
                          options={ROLE_OPTIONS}
                          onValueChange={(val) =>
                            void handleRoleChange(
                              member.userId,
                              val as UserSiteCollaboratorRole,
                            )
                          }
                        />
                        <IconButton
                          variant="ghost"
                          size="sm"
                          disabled={readOnly || busy}
                          aria-label={`移除协作者 ${member.email}`}
                          onClick={() => void handleRemoveCollaborator(member)}
                        >
                          <Trash2 size={15} className="text-muted" aria-hidden="true" />
                        </IconButton>
                      </>
                    ) : (
                      <span className="oc-badge-craft rounded-full bg-surface px-2.5 py-0.5 text-caption text-muted">
                        {roleLabel(member.role)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {isOwner && (
        <section className="oc-surface-card space-y-4 rounded-2xl p-5">
          <div className="flex items-center gap-2.5">
            <span className="oc-icon-badge oc-icon-badge-info size-8 rounded-lg" aria-hidden="true">
              <Link2 size={15} strokeWidth={1.75} />
            </span>
            <div>
              <h3 className="text-section font-semibold text-fg">协作邀请链接</h3>
              <p className="text-caption text-muted">
                生成可随时撤销的邀请链接，协作者打开并确认后即可加入开发
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-36">
              <Select
                aria-label="邀请链接角色"
                value={inviteRole}
                disabled={readOnly || creatingInvite}
                options={ROLE_OPTIONS}
                onValueChange={(val) => setInviteRole(val as UserSiteCollaboratorRole)}
              />
            </div>
            <div className="w-36">
              <Select
                aria-label="邀请链接有效期"
                value={inviteExpiry}
                disabled={readOnly || creatingInvite}
                options={EXPIRY_OPTIONS}
                onValueChange={setInviteExpiry}
              />
            </div>
            <div className="w-32">
              <Select
                aria-label="邀请链接使用上限"
                value={inviteMaxUses}
                disabled={readOnly || creatingInvite}
                options={MAX_USES_OPTIONS}
                onValueChange={setInviteMaxUses}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="h-10 rounded-full px-4"
              disabled={readOnly || creatingInvite}
              onClick={() => void handleCreateInvite()}
            >
              <Link2 size={14} aria-hidden="true" />
              {creatingInvite ? "生成中…" : "生成邀请链接"}
            </Button>
          </div>

          {latestInviteUrl && (
            <div className="oc-callout oc-callout-success space-y-2 rounded-xl p-4">
              <p className="text-caption font-medium text-success">
                新邀请链接已生成（出于安全考虑仅展示这一次，请及时复制）：
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={latestInviteUrl}
                  readOnly
                  aria-label="生成的邀请链接"
                  className="min-w-0 flex-1 font-mono text-caption"
                />
                <Button
                  size="sm"
                  variant="primary"
                  className="rounded-full"
                  onClick={() => void copyText(latestInviteUrl, true)}
                >
                  {copiedUrl ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Copy size={14} aria-hidden="true" />
                  )}
                  {copiedUrl ? "已复制" : "复制链接"}
                </Button>
              </div>
            </div>
          )}

          {invites.length > 0 && (
            <div className="oc-surface-recessed divide-y divide-border/60 overflow-hidden rounded-xl">
              {invites.map((inv) => {
                const busy = busyId === `invite:${inv.id}`;
                return (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-body"
                  >
                    <div className="space-y-0.5">
                      <p className="font-medium text-fg">
                        {roleLabel(inv.role)}邀请链接
                        <span className="ml-2 text-caption font-normal tabular-nums text-muted">
                          已使用 {inv.useCount}
                          {inv.maxUses !== null ? ` / ${inv.maxUses}` : ""} 次
                        </span>
                      </p>
                      <p className="text-caption text-muted">
                        有效期：{formatDateTime(inv.expiresAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={readOnly || busy}
                      className="rounded-full text-danger hover:bg-hover"
                      onClick={() => void handleRevokeInvite(inv.id)}
                    >
                      {busy ? "撤销中…" : "撤销"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {(site.accessRole ?? "owner") !== "viewer" && (
        <section className="oc-code-shell">
          <div className="oc-code-shell-header flex items-center justify-between gap-2 px-4 py-2.5">
            <h3 className="flex items-center gap-2 text-meta font-semibold text-fg">
              <Terminal size={14} className="text-muted" aria-hidden="true" />
              协作开发命令
            </h3>
            <span className="text-micro text-faint">CLI</span>
          </div>
          <div className="space-y-2.5 p-4">
            <p className="text-caption text-muted">
              协作者在自己的对话中点击右上角「实时编辑」或「编辑」即可直接协同修改；也可在容器终端运行以下命令拉取和更新站点：
            </p>
            <div className="space-y-2 font-mono text-caption text-fg">
              <div className="oc-surface-recessed flex items-center justify-between gap-2 rounded-lg px-3 py-2">
                <span className="truncate">{pullCmd}</span>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="复制拉取命令"
                  onClick={() => void copyText(pullCmd)}
                >
                  <Copy size={14} />
                </IconButton>
              </div>
              <div className="oc-surface-recessed flex items-center justify-between gap-2 rounded-lg px-3 py-2">
                <span className="truncate">{pushCmd}</span>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="复制发布命令"
                  onClick={() => void copyText(pushCmd)}
                >
                  <Copy size={14} />
                </IconButton>
              </div>
            </div>
          </div>
        </section>
      )}

      {confirmDialogEl}
    </div>
  );
}
