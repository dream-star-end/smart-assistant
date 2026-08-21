import type { ChatProject, SessionBatchAction } from "../../lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Button,
} from "../ui";

export function BatchBar({
  count,
  projects,
  onAction,
  onCancel,
}: {
  count: number;
  projects: ChatProject[];
  onAction: (action: SessionBatchAction, projectId?: string | null) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="mx-1 mb-1 flex flex-wrap items-center gap-1 rounded-lg bg-hover px-2 py-1.5 text-caption"
      data-testid="sidebar-batch-bar"
    >
      <span className="mr-1 font-medium text-fg">已选 {count} 条</span>
      <Button type="button" variant="ghost" size="sm" disabled={count === 0} onClick={() => onAction("archive")}>
        归档
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" disabled={count === 0}>
            移动到项目
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          {projects.length === 0 && <DropdownMenuItem disabled>还没有项目</DropdownMenuItem>}
          {projects.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => onAction("move", p.id)}>
              {p.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => onAction("move", null)}>移出项目</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button type="button" variant="ghost" size="sm" disabled={count === 0} onClick={() => onAction("delete")}>
        删除
      </Button>
      <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
