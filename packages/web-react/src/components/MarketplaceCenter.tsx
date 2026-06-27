import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { AuthSession } from "../lib/types";
import { Tabs } from "./ui";
import { BrowsePanel } from "./marketplace/BrowsePanel";
import { InstalledPanel } from "./marketplace/InstalledPanel";
import { PublishPanel } from "./marketplace/PublishPanel";
import { ReviewPanel } from "./marketplace/ReviewPanel";

export type MarketplaceTab = "browse" | "installed" | "publish" | "review";

/**
 * AI 市场：发现 / 已安装 / 发布 /（管理员）审核。
 * 复用 ManageCenter 的 Dialog + Tabs 结构。后端 marketplace 路由不在 bridge
 * allowlist、强制浏览器 JWT —— 容器/agent 无法绕过自装自发。demo/未登录不渲染。
 */
export function MarketplaceCenter({
  open,
  tab,
  auth,
  isAdmin,
  onTabChange,
  onClose,
}: {
  open: boolean;
  tab: MarketplaceTab;
  auth: AuthSession | null;
  isAdmin: boolean;
  onTabChange: (t: MarketplaceTab) => void;
  onClose: () => void;
}) {
  const tabs: { value: MarketplaceTab; label: string }[] = [
    { value: "browse", label: "发现" },
    { value: "installed", label: "已安装" },
    { value: "publish", label: "发布" },
    ...(isAdmin ? [{ value: "review" as const, label: "审核" }] : []),
  ];
  // admin 关闭时若停在 review，回落到 browse。
  const safeTab: MarketplaceTab = tab === "review" && !isAdmin ? "browse" : tab;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-fg">AI 市场</Dialog.Title>
              <p className="mt-0.5 text-[12px] text-faint">发现并安装技能，或把自己的技能分享给大家。</p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-3">
            <Tabs
              aria-label="市场分区"
              value={safeTab}
              onValueChange={(v) => onTabChange(v as MarketplaceTab)}
              items={tabs.map((t) => ({ value: t.value, label: t.label }))}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <>
                {safeTab === "browse" && <BrowsePanel auth={auth} />}
                {safeTab === "installed" && (
                  <InstalledPanel auth={auth} onGoBrowse={() => onTabChange("browse")} />
                )}
                {safeTab === "publish" && <PublishPanel auth={auth} />}
                {safeTab === "review" && isAdmin && <ReviewPanel auth={auth} />}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
