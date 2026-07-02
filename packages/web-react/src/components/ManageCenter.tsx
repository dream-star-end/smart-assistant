import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { AuthSession } from "../lib/types";
import { Tabs } from "./ui";
import { CronPanel } from "./manage/CronPanel";
import { MemoryPanel } from "./manage/MemoryPanel";
import { SkillsPanel } from "./manage/SkillsPanel";

export type ManageTab = "memory" | "cron" | "skills";

const TABS: { id: ManageTab; label: string }[] = [
  { id: "memory", label: "记忆" },
  { id: "cron", label: "定时任务" },
  { id: "skills", label: "技能" },
];

/**
 * 管理中心：记忆 / 定时任务 / 技能，均经 commercial router 容器代理读写用户容器内 gateway。
 * 与设置中心（账户/计费/偏好）分离 —— 这里是「智能体数据」管理。各 Tab 懒加载，
 * demo/未登录不渲染网络分区。Dialog 定高（非 max-h）：切 Tab 时高度不随内容跳动。
 */
export function ManageCenter({
  open,
  tab,
  auth,
  agentId,
  agents,
  onTabChange,
  onClose,
}: {
  open: boolean;
  tab: ManageTab;
  auth: AuthSession | null;
  /** 记忆按 agent 维度；默认选中当前对话 agent。 */
  agentId: string;
  /** 可切换的智能体（全能助手 + 已安装市场智能体），记忆面板内切换。 */
  agents: { id: string; name: string }[];
  onTabChange: (t: ManageTab) => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(85vh,44rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">管理中心</Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-3">
            <Tabs
              aria-label="管理分区"
              value={tab}
              onValueChange={(v) => onTabChange(v as ManageTab)}
              items={TABS.map((t) => ({ value: t.id, label: t.label }))}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <>
                {tab === "memory" && <MemoryPanel auth={auth} agentId={agentId} agents={agents} />}
                {tab === "cron" && <CronPanel auth={auth} />}
                {tab === "skills" && <SkillsPanel auth={auth} />}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
