import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { canManageOrgBilling } from "../lib/orgBilling";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { AuthSession, OrgRole, OrgSubscriptionInfo, User } from "../lib/types";
import { Tabs } from "./ui";
import { CreateOrgWizard } from "./org/CreateOrgWizard";
import { InvoicesTab } from "./org/InvoicesTab";
import { MembersTab } from "./org/MembersTab";
import { OrgSubscribeDialog, type OrgSubMode } from "./org/OrgSubscribeDialog";
import { orgErrText } from "./org/orgShared";
import { OverviewTab } from "./org/OverviewTab";
import { ReportsTab } from "./org/ReportsTab";
import { SkillsTab } from "./org/SkillsTab";

// 共享 helper 已迁至叶子模块 org/orgShared(权威源);此处 re-export 兼容既有引用点。
export { orgErrText, orgRoleLabel } from "./org/orgShared";

export type OrgSection = "overview" | "members" | "skills" | "reports" | "invoices";

const SECTIONS: { id: OrgSection; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "members", label: "成员" },
  { id: "skills", label: "技能" },
  { id: "reports", label: "报表" },
  { id: "invoices", label: "发票" },
];

/**
 * 组织中心（企业版 P3.1）：概览 / 成员 / 技能 / 报表 / 发票 五分区。
 *
 * 骨架镜像 SettingsCenter（Dialog + 分段 Tabs + 滚动 body）。org 由服务端从 caller
 * membership 推导，前端任何请求**不带** org_id。各分区懒加载（组件按 section 条件渲染，
 * 首次挂载即拉；useEffect 依赖数组绝不含自身 loading，防永久转圈——见各 Tab 注释）。
 *
 * 计费面注意：批次 B（充值/余额/订单/流水）、批次 C（技能）端点集成期可能 404/501，
 * 相关 Tab 一律 try/catch，失败时以 orgErrText 展示后端文案（优先 ApiError.message），
 * 绝不白屏。大数（credits / token / amount_cents）全程字符串，禁止 Number() 化。
 *
 * 入口权限：App 仅对 org owner/admin 开放本中心（成员在设置·账户页只读展示归属）。
 * callerRole 仍按 user.org.role 传下，成员维度控件（改角色）在 owner 才显示。
 */
export function OrgCenter({
  open,
  auth,
  user,
  onClose,
  onRefreshMe,
  initialSection = "overview",
}: {
  open: boolean;
  auth: AuthSession | null;
  user: User | null;
  onClose: () => void;
  /** 充值到账 / 成员变更后调用（App 重拉 /api/me）。 */
  onRefreshMe?: () => void;
  /** 教程等外部入口可直达具体分区；无组织用户仍优先显示创建向导。 */
  initialSection?: OrgSection;
}) {
  const [section, setSection] = useState<OrgSection>(initialSection);

  const noOrg = !user?.org;
  const callerRole: OrgRole = user?.org?.role ?? "member";
  // 计费写面门:owner 恒可 + 财务委派被授予者(三期)。派生自 /api/me 的 org.billing_delegate。
  const canManageBilling = canManageOrgBilling(callerRole, user?.org?.billing_delegate);

  // ── 订阅单一权威源(二期):OrgCenter 顶层拉一次,概览渲染 + 成员满席闸共用。 ──
  const [subInfo, setSubInfo] = useState<OrgSubscriptionInfo | null>(null);
  const [subLoading, setSubLoading] = useState(false);
  const [subErr, setSubErr] = useState<string | null>(null);
  const [subReload, setSubReload] = useState(0);
  // 到账后概览重拉(org 钱包 / 成员数),bump 传入 OverviewTab 的 reloadKey。
  const [overviewReload, setOverviewReload] = useState(0);
  // owner 订阅 / 加席弹层(两模式);OrgCenter 托管,概览与成员页均可触发。
  const [payDialog, setPayDialog] = useState<OrgSubMode | null>(null);

  // 关闭面板：复位分区（避免重开残留在非概览页）。
  useEffect(() => {
    if (open) {
      setSection(initialSection);
    } else {
      setSection("overview");
      setPayDialog(null);
    }
  }, [open, initialSection]);

  // 有 org 时拉订阅(member 可读)。依赖不含 subLoading(防转圈);noOrg / 未登录不拉。
  useEffect(() => {
    if (!open || !auth || noOrg) {
      setSubInfo(null);
      return;
    }
    let alive = true;
    setSubLoading(true);
    setSubErr(null);
    api
      .getOrgSubscription(auth)
      .then((info) => {
        if (alive) setSubInfo(info);
      })
      .catch((e) => {
        if (alive) setSubErr(orgErrText(e, "加载订阅信息失败"));
      })
      .finally(() => {
        if (alive) setSubLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, auth, noOrg, subReload]);

  // 订阅 / 加席到账:刷新归属 + 重拉订阅 + 概览。
  const onSubPaid = useCallback(() => {
    onRefreshMe?.();
    setSubReload((n) => n + 1);
    setOverviewReload((n) => n + 1);
  }, [onRefreshMe]);

  const showWizard = !!auth && noOrg;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="oc-center-dialog fixed left-1/2 z-50 flex h-[min(85vh,46rem)] h-[min(85dvh,46rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <Dialog.Title className="min-w-0 truncate text-[15px] font-semibold text-fg">
              {showWizard ? "创建组织" : (user?.org?.name ?? "组织")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          {/* 无 org 用户(如深链 ?panel=org):直呈创建向导,不显分区 Tabs。 */}
          {!showWizard && (
            <div className="border-b border-border px-4 pb-3">
              <div className="overflow-x-auto">
                <Tabs
                  aria-label="组织分区"
                  value={section}
                  onValueChange={(v) => setSection(v as OrgSection)}
                  items={SECTIONS.map((s) => ({
                    value: s.id,
                    label: s.label,
                    featureId: PRODUCT_CAPABILITIES.organization.id,
                  }))}
                />
              </div>
            </div>
          )}

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            data-product-feature={PRODUCT_CAPABILITIES.organization.id}
          >
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : showWizard ? (
              <CreateOrgWizard auth={auth} onCreated={() => onRefreshMe?.()} onCancel={onClose} />
            ) : (
              <>
                {section === "overview" && (
                  <OverviewTab
                    auth={auth}
                    onRefreshMe={onRefreshMe}
                    reloadKey={overviewReload}
                    subInfo={subInfo}
                    subLoading={subLoading}
                    subErr={subErr}
                    canManageBilling={canManageBilling}
                    onSubscribe={() => setPayDialog("subscribe")}
                    onAddSeats={() => setPayDialog("seats")}
                  />
                )}
                {section === "members" && (
                  <MembersTab
                    auth={auth}
                    callerRole={callerRole}
                    onRefreshMe={onRefreshMe}
                    subscription={subInfo?.subscription ?? null}
                    canManageBilling={canManageBilling}
                    onAddSeats={() => setPayDialog("seats")}
                  />
                )}
                {section === "skills" && <SkillsTab auth={auth} />}
                {section === "reports" && <ReportsTab auth={auth} />}
                {section === "invoices" && (
                  <InvoicesTab auth={auth} canManageBilling={canManageBilling} />
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {/* owner 订阅 / 加席弹层(概览与成员页共用触发)。 */}
      {auth && !noOrg && (
        <OrgSubscribeDialog
          open={payDialog != null}
          auth={auth}
          mode={payDialog ?? "subscribe"}
          subInfo={subInfo}
          onClose={() => setPayDialog(null)}
          onPaid={onSubPaid}
        />
      )}
    </Dialog.Root>
  );
}
