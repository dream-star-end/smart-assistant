/**
 * PR1 Codex 桌面密度对照场景：左栏会话 / 工具卡 / Composer / 设置关于页。
 * 不含 Dialog 的聊天场景走整页截图；设置场景由 shoot.mjs 裁到 [role=dialog]。
 */
import { Composer } from "../../src/components/Composer";
import { SettingsCenter } from "../../src/components/SettingsCenter";
import { Sidebar } from "../../src/components/Sidebar";
import { ToolCard } from "../../src/components/ToolCard";
import { BoundRepoCard } from "../../src/components/contextRail/BoundRepoCard";
import { ContextRail } from "../../src/components/contextRail/ContextRail";
import { PinnedTaskTracker } from "../../src/components/chat/PinnedTaskTracker";
import { useXlViewport } from "../../src/hooks/useXlViewport";
import { createMemoryAuthSession } from "../../src/lib/authSession";
import type { RepoSelection, Session, User } from "../../src/lib/types";
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
    updatedAt: new Date().toISOString(),
    messageCount: 4,
  },
  {
    id: "s-idle",
    title: "空闲会话对照",
    ownerUserId: user.id,
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
        <Composer
          onSend={() => {}}
          models={[
            { id: "glm-5.2", display_name: "GLM-5.2" },
            { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
          ]}
          selectedModelId="glm-5.2"
          onSelectModel={() => {}}
        />
      </div>
    </div>
  );
}

const RAIL_SELECTION: Extract<RepoSelection, { selected: true }> = {
  selected: true,
  owner: "acme",
  repo: "aurora",
  branch: "feat/rail",
  status: "ready",
  head_sha: "abcdef1234567890",
  selection_version: 1,
};

function WorkspaceContextRail() {
  const isXl = useXlViewport();
  const todos = [{ content: "修右栏单实例", status: "in_progress", activeForm: "正在修右栏" }];
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
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
          <div className="mx-auto w-full max-w-3xl text-body text-muted">会话正文对照</div>
        </div>
        {!isXl && <PinnedTaskTracker todos={todos} active />}
        <Composer
          onSend={() => {}}
          onOpenRepo={() => {}}
          repoSelection={RAIL_SELECTION}
          showRepoPill={!isXl}
          models={[
            { id: "glm-5.2", display_name: "GLM-5.2" },
            { id: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" },
          ]}
          selectedModelId="glm-5.2"
          onSelectModel={() => {}}
        />
      </div>
      {isXl && (
        <ContextRail
          renderers={{
            "bound-repo": <BoundRepoCard selection={RAIL_SELECTION} onOpenRepo={() => {}} />,
            "pinned-tasks": <PinnedTaskTracker todos={todos} active compact />,
          }}
          onHide={() => {}}
        />
      )}
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
  {
    id: "workspace-context-rail",
    label: "工作区 · xl 右栏绑定仓库与任务 HUD",
    group: "工作区",
    viewports: ["desktop", "mobile"],
    api: {},
    render: () => <WorkspaceContextRail />,
  },
];
