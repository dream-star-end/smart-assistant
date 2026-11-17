import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  TooltipProvider,
} from "../src/components/ui";
import type { ChatProject } from "../src/lib/types";

const noop = () => {};
const SUBMENU_GROUPS = Array.from({ length: 12 }, (_, idx) => ({
  id: `group-${idx + 1}`,
  label: `项目分组 ${idx + 1}`,
}));

function Harness() {
  const [lastAction, setLastAction] = useState("none");
  const upperProject = { id: "p-upper", name: "四维时空", color: null, pinnedAt: null } as unknown as ChatProject;
  const targetProject = { id: "p-target", name: "外协采购", color: null, pinnedAt: null } as unknown as ChatProject;

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
        <aside
          data-testid="sidebar"
          className="flex h-full w-[268px] shrink-0 flex-col border-r border-border bg-sidebar px-2 py-2"
        >
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-caption text-faint">项目列表</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="submenu-trigger-root"
                  className="rounded-sm border border-border px-2 py-0.5 text-caption text-fg"
                >
                  会话菜单
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="submenu-trigger">移至项目</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-44">
                    {SUBMENU_GROUPS.map((g) => (
                      <DropdownMenuItem
                        key={g.id}
                        onSelect={() => setLastAction(`move:${g.id}`)}
                      >
                        {g.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="h-9 shrink-0" data-testid="row-upper">
            <ProjectRow
              project={upperProject}
              count={5}
              collapsed={true}
              dropActive={false}
              allowDrag={true}
              showMoveInMenu={true}
              canMoveUp={false}
              canMoveDown={true}
              onToggle={noop}
              onOpen={noop}
              onNewSession={() => setLastAction("upper-new-session")}
              onOpenSettings={noop}
              onRename={noop}
              onMoveUp={noop}
              onMoveDown={noop}
              onTogglePin={noop}
              onArchive={noop}
              onDelete={noop}
              onDragOverSession={noop}
              onDragLeave={noop}
              onDropSessionId={noop}
            />
          </div>

          {/* Place「外协采购」in the lower half (~y=228px on 640x320) so Radix flips side="top", matching user screenshot */}
          <div style={{ height: 156 }} className="shrink-0" />

          <div className="h-9 shrink-0" data-testid="row-target">
            <ProjectRow
              project={targetProject}
              count={17}
              collapsed={false}
              dropActive={false}
              allowDrag={true}
              showMoveInMenu={true}
              canMoveUp={true}
              canMoveDown={true}
              onToggle={noop}
              onOpen={noop}
              onNewSession={() => setLastAction("new-session")}
              onOpenSettings={() => setLastAction("settings")}
              onRename={() => setLastAction("rename")}
              onMoveUp={() => setLastAction("move-up")}
              onMoveDown={() => setLastAction("move-down")}
              onTogglePin={() => setLastAction("pin")}
              onArchive={() => setLastAction("archive")}
              onDelete={() => setLastAction("delete")}
              onDragOverSession={noop}
              onDragLeave={noop}
              onDropSessionId={noop}
            />
          </div>

          <div className="mt-auto pt-1 text-caption text-faint" data-testid="last-action">
            {lastAction}
          </div>
        </aside>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
