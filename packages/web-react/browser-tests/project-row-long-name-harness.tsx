import { createRoot } from "react-dom/client";
import { ProjectRow } from "../src/components/sidebar/ProjectRow";
import { TooltipProvider } from "../src/components/ui";
import type { ChatProject } from "../src/lib/types";

// OCV5-364: the real ProjectRow in a default-width (268px) sidebar column. Fixture projects only.
const projects = [
  { id: "p-short", name: "test", count: 101 },
  { id: "p-long", name: "V5个人版和商业版项目开发", count: 9 },
  { id: "p-longer", name: "一个非常非常非常非常长的项目名称用来测试截断效果", count: 12 },
];
const noop = () => {};

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <aside data-testid="sidebar" className="w-[268px] bg-sidebar px-2 py-2 text-fg">
      {projects.map(({ id, name, count }) => (
        <div key={id} className="h-8" data-testid={`row-${id}`}>
          <ProjectRow
            project={{ id, name } as ChatProject}
            count={count}
            collapsed={false}
            dropActive={false}
            allowDrag={false}
            showMoveInMenu={false}
            canMoveUp={false}
            canMoveDown={false}
            onToggle={noop}
            onOpen={noop}
            onRename={noop}
            onDelete={noop}
            onNewSession={noop}
            onDragOverSession={noop}
            onDragLeave={noop}
            onDropSessionId={noop}
          />
        </div>
      ))}
    </aside>
  </TooltipProvider>,
);
