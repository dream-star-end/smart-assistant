import { Check, Folder, FolderOpen } from "lucide-react";
import { PROJECT_COLORS } from "../lib/projectColors";
import type { ChatProject } from "../lib/types";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/DropdownMenu";

const PILL =
  "inline-flex min-w-0 max-w-[11rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.98] sm:max-w-[16rem]";

function ProjectDot({ color }: { color: string | null | undefined }) {
  const swatch = PROJECT_COLORS.find((c) => c.key === color);
  return swatch ? (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", swatch.dotClass)} />
  ) : (
    <FolderOpen size={14} aria-hidden className="shrink-0" />
  );
}

/**
 * 输入框里的「项目」标识。
 *
 * 新会话草稿(`editable`):发送前就看得见这条会话会进哪个项目,可以改、可以不放进项目。
 * 已有会话:只显示所在项目,点开项目;移动会话仍走会话菜单(避免误触改归属)。
 * 一个项目都没有且草稿未选项目时不渲染,不给没用项目的人加噪音。
 */
export function ComposerProjectPill({
  projects,
  projectId,
  editable,
  onPick,
  onOpen,
}: {
  projects: ChatProject[];
  projectId: string | null;
  editable: boolean;
  onPick?: (projectId: string | null) => void;
  onOpen?: (projectId: string) => void;
}) {
  const current = projectId ? projects.find((p) => p.id === projectId) ?? null : null;
  if (!editable) {
    if (!current) return null;
    return (
      <button
        type="button"
        data-testid="composer-project-pill"
        className={cn(PILL, "border-accent/40 bg-accent-soft text-accent hover:border-accent/60")}
        aria-label={`所在项目：${current.name}，点击打开项目`}
        title={`所在项目：${current.name}`}
        onClick={() => onOpen?.(current.id)}
      >
        <ProjectDot color={current.color} />
        <span className="truncate">{current.name}</span>
      </button>
    );
  }
  if (!current && projects.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="composer-project-pill"
          data-project-id={current?.id ?? ""}
          className={cn(
            PILL,
            current
              ? "border-accent/40 bg-accent-soft text-accent hover:border-accent/60"
              : "border-border text-muted hover:border-border-strong hover:bg-hover hover:text-fg",
          )}
          aria-label={current ? `这条会话会放进项目「${current.name}」，点击更改` : "选择项目（当前不放进项目）"}
          title={current ? `会放进项目「${current.name}」` : "选择项目"}
        >
          {current ? <ProjectDot color={current.color} /> : <Folder size={14} aria-hidden className="shrink-0" />}
          <span className="truncate">{current ? current.name : "不放进项目"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-[50vh] min-w-[12rem] overflow-y-auto">
        <DropdownMenuLabel>这条新会话放进</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onPick?.(p.id)}>
            <ProjectDot color={p.color} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.id === current?.id && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
          </DropdownMenuItem>
        ))}
        {projects.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => onPick?.(null)}>
          <Folder size={14} aria-hidden className="shrink-0 text-muted" />
          <span className="flex-1">不放进项目</span>
          {!current && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
