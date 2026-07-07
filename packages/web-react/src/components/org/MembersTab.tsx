import { UserPlus, Users } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type {
  AuthSession,
  OrgInvitation,
  OrgMember,
  OrgRole,
  OrgSubscriptionView,
} from "../../lib/types";
import { Alert, Badge, Button, Input, Spinner, Switch, useConfirm, useToast } from "../ui";
import { shortTime } from "../settings/labels";
import { orgErrText, orgRoleLabel } from "./orgShared";

/** org 角色 → 徽章色调。 */
function roleTone(role: OrgRole): "accent" | "info" | "neutral" {
  return role === "owner" ? "accent" : role === "admin" ? "info" : "neutral";
}

/** 邀请状态 → 中文 + 色调。 */
function invStatusMeta(status: OrgInvitation["status"]): {
  label: string;
  tone: "info" | "success" | "neutral";
} {
  switch (status) {
    case "pending":
      return { label: "待接受", tone: "info" };
    case "accepted":
      return { label: "已加入", tone: "success" };
    case "revoked":
      return { label: "已撤销", tone: "neutral" };
    case "expired":
      return { label: "已过期", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/**
 * 成员：成员列表（角色/状态/组织结算开关）+ 邀请表单 + 邀请列表。
 * owner 行不可改角色/不可移除；改角色控件仅 caller 为 owner 时可见（admin 看不到）。
 * 数据走批次 A 已就绪端点。变更后重拉列表；影响成员数的操作额外 onRefreshMe。
 */
export function MembersTab({
  auth,
  callerRole,
  onRefreshMe,
  subscription = null,
  canManageBilling = false,
  onAddSeats,
}: {
  auth: AuthSession;
  callerRole: OrgRole;
  onRefreshMe?: () => void;
  /** 当前订阅(席位闸:有订阅时以 seats 为上限,来自 OrgCenter 单一权威)。 */
  subscription?: OrgSubscriptionView;
  /** owner 才可加席。 */
  canManageBilling?: boolean;
  onAddSeats?: () => void;
}) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [busyInv, setBusyInv] = useState<string | null>(null);

  // 邀请表单
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<OrgRole, "owner">>("member");
  const [inviting, setInviting] = useState(false);

  const [confirm, confirmEl] = useConfirm();
  const toast = useToast();
  const isOwner = callerRole === "owner";

  // 首次挂载拉成员 + 邀请（依赖数组不含 loading，防转圈）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([api.listOrgMembers(auth), api.listOrgInvitations(auth)])
      .then(([ms, invs]) => {
        if (!alive) return;
        setMembers(ms);
        setInvitations(invs);
      })
      .catch((e) => {
        if (alive) setErr(orgErrText(e, "加载成员失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  async function reloadMembers() {
    try {
      setMembers(await api.listOrgMembers(auth));
    } catch (e) {
      toast(orgErrText(e, "刷新成员列表失败"), "error");
    }
  }

  async function reloadInvitations() {
    try {
      setInvitations(await api.listOrgInvitations(auth));
    } catch (e) {
      toast(orgErrText(e, "刷新邀请列表失败"), "error");
    }
  }

  // 组织结算开关：乐观更新 + 失败回退。
  async function toggleBilling(m: OrgMember, next: boolean) {
    setBusyUid(m.user_id);
    setMembers((prev) =>
      prev.map((x) => (x.user_id === m.user_id ? { ...x, billing_enabled: next } : x)),
    );
    try {
      await api.patchOrgMember(auth, m.user_id, { billing_enabled: next });
    } catch (e) {
      setMembers((prev) =>
        prev.map((x) =>
          x.user_id === m.user_id ? { ...x, billing_enabled: m.billing_enabled } : x,
        ),
      );
      toast(orgErrText(e, "修改组织结算失败"), "error");
    } finally {
      setBusyUid(null);
    }
  }

  async function changeRole(m: OrgMember, role: Exclude<OrgRole, "owner">) {
    if (role === m.org_role) return;
    setBusyUid(m.user_id);
    try {
      await api.patchOrgMember(auth, m.user_id, { org_role: role });
      await reloadMembers();
      toast("已更新成员角色", "success");
    } catch (e) {
      toast(orgErrText(e, "修改角色失败"), "error");
    } finally {
      setBusyUid(null);
    }
  }

  async function removeMember(m: OrgMember) {
    const ok = await confirm({
      title: `移除成员「${m.display_name || m.email}」？`,
      body: "移除后该成员将退出组织，用量不再由组织钱包结算。",
      danger: true,
      confirmText: "移除",
    });
    if (!ok) return;
    setBusyUid(m.user_id);
    try {
      await api.removeOrgMember(auth, m.user_id);
      await reloadMembers();
      onRefreshMe?.();
      toast("已移除成员", "success");
    } catch (e) {
      toast(orgErrText(e, "移除成员失败"), "error");
    } finally {
      setBusyUid(null);
    }
  }

  async function submitInvite(e: FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    try {
      await api.createOrgInvitation(auth, email, inviteRole);
      setInviteEmail("");
      await reloadInvitations();
      toast("邀请已发送", "success");
    } catch (err2) {
      toast(orgErrText(err2, "发送邀请失败"), "error");
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvite(inv: OrgInvitation) {
    setBusyInv(inv.id);
    try {
      await api.revokeOrgInvitation(auth, inv.id);
      await reloadInvitations();
      toast("已撤销邀请", "success");
    } catch (e) {
      toast(orgErrText(e, "撤销邀请失败"), "error");
    } finally {
      setBusyInv(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载成员…
      </div>
    );
  }
  if (err) {
    return (
      <div className="px-5 py-4">
        <Alert tone="danger" className="text-[12.5px]">
          {err}
        </Alert>
      </div>
    );
  }

  const selectCls =
    "h-8 rounded-md border border-border bg-surface px-2 text-[12.5px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

  // 席位闸(友好前置提示;后端 SEATS_FULL 仍是权威):有订阅时活跃成员达 seats 即满。
  const activeMembers = members.filter((m) => m.status === "active").length;
  const seatFull = subscription != null && activeMembers >= subscription.seats;

  return (
    <div className="flex flex-col">
      {/* 成员列表 */}
      <div className="px-5 py-4">
        <div className="pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          成员（{members.length}）
        </div>
        <ul className="flex flex-col gap-1.5">
          {members.map((m) => {
            const ownerRow = m.org_role === "owner";
            const busy = busyUid === m.user_id;
            return (
              <li key={m.user_id} className="rounded-lg border border-border px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-fg">
                      {m.display_name || m.email}
                    </div>
                    <div className="truncate text-[11.5px] text-faint">
                      {m.email} · 加入 {shortTime(m.joined_at)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={roleTone(m.org_role)}>{orgRoleLabel(m.org_role)}</Badge>
                    {m.status === "suspended" && <Badge tone="warning">已暂停</Badge>}
                  </div>
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2 text-[12px] text-muted">
                    <Switch
                      checked={m.billing_enabled}
                      onCheckedChange={(v) => toggleBilling(m, v)}
                      disabled={busy}
                      aria-label="组织结算"
                    />
                    组织结算
                  </label>

                  {isOwner && !ownerRow && (
                    <label className="flex items-center gap-1.5 text-[12px] text-muted">
                      角色
                      <select
                        className={selectCls}
                        value={m.org_role}
                        disabled={busy}
                        onChange={(e) =>
                          changeRole(m, e.target.value as Exclude<OrgRole, "owner">)
                        }
                      >
                        <option value="admin">管理员</option>
                        <option value="member">成员</option>
                      </select>
                    </label>
                  )}

                  {ownerRow ? (
                    <span className="text-[11.5px] text-faint">拥有者不可变更</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMember(m)}
                      disabled={busy}
                      className="text-danger hover:bg-danger-soft"
                    >
                      移除
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* 邀请成员 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-1.5 pb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
          <UserPlus size={13} /> 邀请成员
        </div>

        {seatFull ? (
          <div className="rounded-lg border border-border bg-warning-soft px-3.5 py-3">
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-warning">
              <Users size={14} /> 席位已满（{activeMembers} / {subscription?.seats} 席）
            </div>
            <p className="mt-1 text-[12px] text-muted">
              {canManageBilling
                ? "当前席位已用满，加席后即可继续邀请新成员。"
                : "当前席位已用满，如需邀请更多成员，请联系组织拥有者加席。"}
            </p>
            {canManageBilling && (
              <Button variant="primary" size="sm" onClick={onAddSeats} className="mt-2">
                <Users size={15} /> 去加席
              </Button>
            )}
          </div>
        ) : (
          <form onSubmit={submitInvite} className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="成员邮箱"
              className="h-9 min-w-[12rem] flex-1"
              required
            />
            <select
              className={selectCls.replace("h-8", "h-9")}
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as Exclude<OrgRole, "owner">)}
              aria-label="邀请角色"
            >
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={inviting || inviteEmail.trim().length === 0}
            >
              {inviting ? <Spinner size={14} /> : null}
              发送邀请
            </Button>
          </form>
        )}

        {invitations.length > 0 && (
          <ul className="mt-3 flex flex-col gap-0.5">
            {invitations.map((inv) => {
              const sm = invStatusMeta(inv.status);
              return (
                <li
                  key={inv.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">{inv.email}</span>
                    <span className="block truncate text-[11.5px] text-faint">
                      {orgRoleLabel(inv.org_role)} · {shortTime(inv.created_at)}
                    </span>
                  </span>
                  <Badge tone={sm.tone}>{sm.label}</Badge>
                  {inv.status === "pending" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => revokeInvite(inv)}
                      disabled={busyInv === inv.id}
                      className="text-muted"
                    >
                      撤销
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {confirmEl}
    </div>
  );
}
