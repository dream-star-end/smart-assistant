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
  allTrashed = false,
  projects,
  onAction,
  onCancel,
}: {
  count: number;
  /** 所选会话全部在回收站：按钮换成 还原 / 彻底删除（归档/移动/删除对 trashed 会话无意义）。 */
  allTrashed?: boolean;
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
      {allTrashed ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={() => onAction("restore")}
          >
            还原
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={() => onAction("purge")}
          >
            彻底删除
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={() => onAction("archive")}
          >
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={() => onAction("delete")}
          >
            删除
          </Button>
        </>
      )}
      <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
