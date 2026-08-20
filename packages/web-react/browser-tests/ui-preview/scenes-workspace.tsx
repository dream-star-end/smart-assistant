/**
 * PR1 Codex 桌面密度对照场景：左栏会话 / 工具卡 / Composer / 设置关于页。
 * 不含 Dialog 的聊天场景走整页截图；设置场景由 shoot.mjs 裁到 [role=dialog]。
 */
import { Composer } from "../../src/components/Composer";
import { SettingsCenter } from "../../src/components/SettingsCenter";
import { Sidebar } from "../../src/components/Sidebar";
import { ToolCard } from "../../src/components/ToolCard";
import { createMemoryAuthSession } from "../../src/lib/authSession";
import type { Session, User } from "../../src/lib/types";
import type { Scene } from "./types";

const auth = createMemoryAuthSession(() => {}, "preview-token");

const user: User = {
  id: "workspace-preview",
  displayName: "密度预览",
  roles: ["user"],
  role: "admin",
};

const sessions: Session[] = [
  {
    id: "s-active",
    title: "对齐 Codex 桌面密度",
    ownerUserId: user.id,
    createdAt: Date.now() - 8 * 60_000,
    lastAt: Date.now(),
    updatedAt: new Date().toISOString(),
    messageCount: 4,
  },
  {
    id: "s-idle",
    title: "空闲会话对照",
    ownerUserId: user.id,
    createdAt: Date.now() - 70 * 60_000,
    lastAt: Date.now() - 60 * 60_000,
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    messageCount: 1,
  },
];

function WorkspaceChat() {
  return (
    <div className="flex h-screen bg-bg text-fg">
      <Sidebar
        sessions={sessions}
        activeId="s-active"
        user={user}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onOpenManage={() => {}}
        onOpenMarketplace={() => {}}
        onOpenTutorial={() => {}}
        onOpenOrg={() => {}}
        showAdmin
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mx-auto w-full max-w-3xl">
            <ToolCard
              message={{
                toolName: "Bash",
                inputJson: { command: "oc-market search browser" },
                output: JSON.stringify([
                  { slug: "preview-skill", name: "预览技能", kind: "skill", description: "密度对照" },
                ]),
                _completed: true,
              }}
            />
          </div>
        </div>
        <Composer onSend={() => {}} />
      </div>
    </div>
  );
}

export const workspaceScenes: Scene[] = [
  {
    id: "workspace-chat-density",
    label: "工作区 · 会话栏+工具卡+输入框密度",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <WorkspaceChat />,
  },
  {
    id: "workspace-settings-about",
    label: "工作区 · 设置关于页标题与说明档",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => (
      <SettingsCenter
        open
        demo
        auth={auth}
        user={user}
        theme="light"
        onClose={() => {}}
        onSetTheme={() => {}}
        onOpenMemory={() => {}}
        initialSection="about"
      />
    ),
  },
];
