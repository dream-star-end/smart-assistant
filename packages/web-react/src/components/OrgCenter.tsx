import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { AuthSession, OrgRole, User } from "../lib/types";
import { Tabs } from "./ui";
import { InvoicesTab } from "./org/InvoicesTab";
import { MembersTab } from "./org/MembersTab";
import { OverviewTab } from "./org/OverviewTab";
import { ReportsTab } from "./org/ReportsTab";
import { SkillsTab } from "./org/SkillsTab";

type Section = "overview" | "members" | "skills" | "reports" | "invoices";

const SECTIONS: { id: Section; label: string }[] = [
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
}: {
  open: boolean;
  auth: AuthSession | null;
  user: User | null;
  onClose: () => void;
  /** 充值到账 / 成员变更后调用（App 重拉 /api/me）。 */
  onRefreshMe?: () => void;
}) {
  const [section, setSection] = useState<Section>("overview");

  // 关闭面板：复位分区（避免重开残留在非概览页）。
  useEffect(() => {
    if (!open) setSection("overview");
  }, [open]);

  const callerRole: OrgRole = user?.org?.role ?? "member";

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(85vh,46rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <Dialog.Title className="min-w-0 truncate text-[15px] font-semibold text-fg">
              {user?.org?.name ?? "组织"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-3">
            <div className="overflow-x-auto">
              <Tabs
                aria-label="组织分区"
                value={section}
                onValueChange={(v) => setSection(v as Section)}
                items={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <>
                {section === "overview" && (
                  <OverviewTab auth={auth} onRefreshMe={onRefreshMe} />
                )}
                {section === "members" && (
                  <MembersTab auth={auth} callerRole={callerRole} onRefreshMe={onRefreshMe} />
                )}
                {section === "skills" && <SkillsTab auth={auth} />}
                {section === "reports" && <ReportsTab auth={auth} />}
                {section === "invoices" && <InvoicesTab auth={auth} />}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── 组织中心共享纯函数（唯一权威源，各 Tab 复用；须为 function 声明以规避循环导入 TDZ） ──

/** org 角色 → 中文标签。 */
export function orgRoleLabel(role: OrgRole): string {
  return role === "owner" ? "拥有者" : role === "admin" ? "管理员" : "成员";
}

/**
 * 错误 → 展示文案：优先后端原文（ApiError.message 已含 501 NOT_IMPLEMENTED / 404 等），
 * 退化到通用 Error.message，最后 fallback。集成期批次 B/C 端点未上线时的友好提示由此产出。
 */
export function orgErrText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.message || fallback;
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}
