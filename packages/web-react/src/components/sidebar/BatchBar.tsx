import { Archive, ArchiveRestore, FolderInput, Trash2 } from "lucide-react";
import type { ChatProject, SessionBatchAction } from "../../lib/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "../ui";

/**
 * 多选批量条。固定两行：第一行「已选 N 条 … 取消」，第二行图标按钮组（归档 / 取消归档 / 移动到项目 / 删除）。
 * 不再 flex-wrap：268px 折 2 行、220px 折 3 行且「取消」被挤到单独一行的问题不再出现（BB-01）；
 * 「删除」用 danger 变体与普通操作区分（BB-02）；选中集合里有已归档会话时给出「取消归档」（BB-03）。
 */
export function BatchBar({
  count,
  projects,
  hasArchivedSelected = false,
  onAction,
  onCancel,
}: {
  count: number;
  projects: ChatProject[];
  /** 选中集合里含已归档会话：显示「取消归档」。 */
  hasArchivedSelected?: boolean;
  onAction: (action: SessionBatchAction, projectId?: string | null) => void;
  onCancel: () => void;
}) {
  const disabled = count === 0;
  return (
    <div
      className="mx-1 mb-1 flex flex-col gap-1 rounded-lg bg-hover px-2 py-1.5 text-caption"
      data-testid="sidebar-batch-bar"
      role="toolbar"
      aria-label="批量操作"
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">已选 {count} 条</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-caption"
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="归档"
          title="归档"
          disabled={disabled}
          onClick={() => onAction("archive")}
        >
          <Archive size={15} />
        </IconButton>
        {hasArchivedSelected && (
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            shape="square"
            aria-label="取消归档"
            title="取消归档"
            disabled={disabled}
            onClick={() => onAction("unarchive")}
          >
            <ArchiveRestore size={15} />
          </IconButton>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              shape="square"
              aria-label="移动到项目"
              title="移动到项目"
              disabled={disabled}
            >
              <FolderInput size={15} />
            </IconButton>
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
        <IconButton
          type="button"
          variant="danger"
          size="sm"
          shape="square"
          aria-label="删除"
          title="删除"
          disabled={disabled}
          className="ml-auto"
          onClick={() => onAction("delete")}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}
