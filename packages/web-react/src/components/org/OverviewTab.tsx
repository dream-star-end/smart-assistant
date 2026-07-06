import { Building2, Users, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, OrgStatus, OrgSummary } from "../../lib/types";
import { cn, formatCredits } from "../../lib/utils";
import { Alert, Badge, Button, Spinner } from "../ui";
import { orgRoleLabel, orgErrText } from "../OrgCenter";
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

/**
 * 概览：组织名 / 状态徽章 / 我的角色 / 成员数（member_count/max_members）/ 组织钱包余额
 * （大字）+ 充值入口。org suspended 显 Alert 提示。数据走 GET /api/org（批次 A 已就绪）。
 * 充值（批次 B）经 OrgTopupDialog；到账后 onRefreshMe + 本页重拉。
 */
export function OverviewTab({
  auth,
  onRefreshMe,
}: {
  auth: AuthSession;
  onRefreshMe?: () => void;
}) {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [topupOpen, setTopupOpen] = useState(false);

  // 首次挂载 + reload（到账后）拉概览。
  // 依赖数组**绝不含 loading** —— effect 自身 setLoading 会改它，触发 cleanup 再重跑，
  // 使 fetch 回来时 alive 已 false → 永久转圈。仅 auth/reload 变时触发。
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
  }, [auth, reload]);

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

      {/* 成员数 */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <Users size={14} /> 成员
          </span>
          <span className="text-[13.5px] font-medium tabular-nums text-fg">
            {org.member_count}
            <span className="text-faint"> / {org.max_members}</span>
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
            <Wallet size={15} /> 组织充值
          </Button>
        </div>
        <p className="mt-2 text-[12px] text-faint">
          成员对话用量可由组织钱包统一结算（按成员的「组织结算」开关生效）。
          充值到账后余额即时可用。
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
