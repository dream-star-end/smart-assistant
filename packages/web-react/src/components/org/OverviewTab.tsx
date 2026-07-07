import { Building2, CalendarClock, Crown, Plus, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { computeSeatTotal, ratioPct, seatsUsage } from "../../lib/orgBilling";
import type { AuthSession, OrgStatus, OrgSubscriptionInfo, OrgSummary } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Badge, Button, Progress, Spinner } from "../ui";
import { orgRoleLabel, orgErrText } from "./orgShared";
import { OrgTopupDialog } from "./OrgTopupDialog";

/** org 状态 → 徽章文案与色调。 */
function statusMeta(status: OrgStatus): {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  switch (status) {
    case "active":
      return { label: "正常", tone: "success" };
    case "suspended":
      return { label: "已暂停", tone: "warning" };
    case "deleting":
      return { label: "删除中", tone: "danger" };
    case "deleted":
      return { label: "已删除", tone: "danger" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** ISO → YYYY-MM-DD(到期日展示)。 */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 概览：组织名 / 状态 / 角色 + 订阅面板(档位·席位·期内池) + 成员数 + 组织钱包余额(充值)。
 * 组织概要走 GET /api/org(批次 A);订阅由 OrgCenter 顶层拉取经 props 下发(单一权威),
 * owner 订阅/加席按钮触发 OrgCenter 托管的弹层。余额区分「期内池」(订阅)与「组织钱包」两数。
 */
export function OverviewTab({
  auth,
  onRefreshMe,
  reloadKey = 0,
  subInfo,
  subLoading = false,
  subErr = null,
  canManageBilling = false,
  onSubscribe,
  onAddSeats,
}: {
  auth: AuthSession;
  onRefreshMe?: () => void;
  /** OrgCenter 到账后 bump,触发概览重拉(钱包 / 成员数)。 */
  reloadKey?: number;
  /** 订阅信息(OrgCenter 单一权威)。 */
  subInfo?: OrgSubscriptionInfo | null;
  subLoading?: boolean;
  subErr?: string | null;
  /** owner 才可操作订阅 / 加席。 */
  canManageBilling?: boolean;
  onSubscribe?: () => void;
  onAddSeats?: () => void;
}) {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [topupOpen, setTopupOpen] = useState(false);

  // 首次挂载 + reload（到账后）+ reloadKey（订阅到账）拉概览。
  // 依赖数组**绝不含 loading**（见一期注释：避免 cleanup 重跑致永久转圈）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .getOrg(auth)
      .then((o) => {
        if (alive) setOrg(o);
      })
      .catch((e) => {
        if (alive) setErr(orgErrText(e, "加载组织信息失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload, reloadKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <Spinner /> 加载组织信息…
      </div>
    );
  }
  if (err || !org) {
    return (
      <div className="px-5 py-4">
        <Alert tone="danger" className="text-[12.5px]">
          {err || "组织信息不可用。"}
        </Alert>
      </div>
    );
  }

  const sm = statusMeta(org.status);
  const suspended = org.status === "suspended";

  const sub = subInfo?.subscription ?? null;
  const plan = sub ? (subInfo?.plans.find((p) => p.code === sub.planCode) ?? null) : null;
  const grantedPool = plan && sub ? computeSeatTotal(plan, sub.seats).totalCredits : null;
  const poolPct = grantedPool && sub ? ratioPct(sub.periodCredits, grantedPool) : 0;
  const seats = seatsUsage(sub, org.member_count, org.max_members);

  return (
    <div className="flex flex-col">
      <div className="px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-faint">
          <Building2 size={13} /> 组织
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[18px] font-semibold text-fg">{org.name}</span>
          <Badge tone={sm.tone}>{sm.label}</Badge>
          <Badge tone="neutral">我是{orgRoleLabel(org.role)}</Badge>
        </div>
      </div>

      {suspended && (
        <div className="px-5 pb-2">
          <Alert tone="warning" className="text-[12.5px]">
            该组织已被暂停，组织钱包与共享技能暂不可用。请联系平台客服处理。
          </Alert>
        </div>
      )}

      {/* 订阅面板 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-faint">
          <Crown size={13} /> 企业套餐
        </div>

        {subErr ? (
          <Alert tone="warning" className="mt-2 text-[12.5px]">
            {subErr}
          </Alert>
        ) : subLoading ? (
          <div className="flex items-center gap-2 py-4 text-[13px] text-faint">
            <Spinner size={15} /> 加载订阅…
          </div>
        ) : sub ? (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {/* F 的 subscription 无 plan_name,优先用 plans 列表里的展示名。 */}
              <span className="text-[16px] font-semibold text-fg">{plan?.name ?? sub.planName}</span>
              {sub.status === "active" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                  <CalendarClock size={11} /> 到期 {fmtDate(sub.periodEnd)}
                </span>
              ) : (
                <Badge tone="warning">已到期</Badge>
              )}
            </div>

            {/* 席位 used / total */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="text-muted">席位</span>
                <span className="tabular-nums text-fg">
                  {seats.used}
                  <span className="text-faint"> / {seats.total}</span>
                </span>
              </div>
              <Progress
                value={seats.total > 0 ? (seats.used / seats.total) * 100 : 0}
                className="mt-1.5"
                aria-label="席位占用"
              />
              {seats.full && (
                <p className="mt-1 text-[11.5px] text-warning">席位已满，如需邀请更多成员请加席。</p>
              )}
            </div>

            {/* 期内池余额 + 进度 */}
            <div className="mt-3">
              <div className="flex items-center justify-between text-[12.5px]">
                <span className="text-muted">期内池余额</span>
                <span className="tabular-nums text-fg">
                  {formatCredits(sub.periodCredits)}
                  {grantedPool && <span className="text-faint"> / {formatCredits(grantedPool)}</span>}
                </span>
              </div>
              {grantedPool && (
                <Progress value={poolPct} className="mt-1.5" aria-label="期内池余额占比" />
              )}
              <p className="mt-1 text-[11.5px] text-faint">
                期内池由席位积分汇集，扣费优先消耗；到期清零，超额由组织钱包承接。
              </p>
            </div>

            {canManageBilling && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={onSubscribe} disabled={suspended}>
                  <Crown size={15} /> 续费 / 变更
                </Button>
                <Button variant="secondary" size="sm" onClick={onAddSeats} disabled={suspended}>
                  <Users size={15} /> 加席
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-muted">
              尚未订阅企业套餐。订阅后按席位获得可汇集的期内积分池，闲置席位积分不浪费。
            </p>
            {canManageBilling ? (
              <div className="mt-3">
                <Button variant="primary" size="sm" onClick={onSubscribe} disabled={suspended}>
                  <Crown size={15} /> 订阅企业套餐
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-[11.5px] text-faint">如需订阅，请联系组织拥有者。</p>
            )}
          </>
        )}
      </div>

      {/* 成员数 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <Users size={14} /> 成员
          </span>
          <span className="text-[13.5px] font-medium tabular-nums text-fg">
            {org.member_count}
            <span className="text-faint"> / {sub ? seats.total : org.max_members}</span>
          </span>
        </div>
      </div>

      {/* 组织钱包余额 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-faint">
          <Wallet size={13} /> 组织钱包余额
        </div>
        <div
          className={cn(
            "mt-1 flex items-baseline gap-1.5 text-[28px] font-semibold tracking-tight tabular-nums text-fg",
          )}
        >
          {formatCredits(org.credits)}
          <span className="text-[14px] font-normal text-faint">积分</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setTopupOpen(true)}
            disabled={suspended}
          >
            <Plus size={15} /> 组织充值
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-faint">
          组织钱包承接期内池超额与非订阅用量，永久有效。成员对话用量可由组织钱包统一结算
          （按成员的「组织结算」开关生效）。
        </p>
      </div>

      <OrgTopupDialog
        open={topupOpen}
        auth={auth}
        baselineCredits={org.credits}
        onClose={() => setTopupOpen(false)}
        onPaid={() => {
          onRefreshMe?.();
          setReload((n) => n + 1);
        }}
      />
    </div>
  );
}
