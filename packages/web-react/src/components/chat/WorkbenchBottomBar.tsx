/**
 * Workbench「2-Bar」沉浸阅读器底部操作栏与溢出菜单（OCV5-820）。
 *
 * 将 Slides 翻页 / 幻灯片↔文档模式切换 / 目录入口 / 次级文件操作（复制路径、下载、新窗打开）
 * 与唯一主按钮「批注修改」收敛到单行 44px + safe-area-inset-bottom 底部操作条，
 * 彻底终结 390px 窄屏下多层套娃工具条与重复批注按钮。
 */
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  ListTree,
  MoreHorizontal,
  PencilLine,
  Presentation,
  Send,
  X,
} from "lucide-react";
import { createContext, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useContext, useState } from "react";
import { cn } from "../../lib/utils";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Spinner,
  useToast,
} from "../ui";
import {
  type AnnotationAnchor,
  type DeliverableMeta,
  buildAnnotationPrompt,
  formatAnchorLabel,
} from "./deliverablePreview";
import { useFreshSignedUrl, useSignedDownload } from "./media";

/** 标识当前 Workbench 是否运行在移动端/平板端底部 Sheet 模式。 */
export const WorkbenchSheetContext = createContext(false);

export function useWorkbenchSheet(): boolean {
  return useContext(WorkbenchSheetContext);
}

/** 次级文件操作溢出菜单（复制路径 / 下载 / 新窗口打开），避免窄屏工具条折行。 */
export function FileOverflowMenu({
  path,
  name,
  showOpenInNewWindow = true,
}: {
  path: string;
  name: string;
  showOpenInNewWindow?: boolean;
}) {
  const isContainerFile = path.startsWith("/");
  const { state: dlState, start: startDownload } = useSignedDownload(isContainerFile ? path : null, name);
  const { get: getFreshUrl } = useFreshSignedUrl(isContainerFile ? path : null);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      toast("已复制路径", "success");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast("复制路径失败", "error");
    }
  };

  const openInNewWindow = async () => {
    if (!isContainerFile) return;
    setOpening(true);
    try {
      const url = await getFreshUrl();
      if (!url) {
        toast("暂时无法获取文件访问链接，请稍后再试", "error");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(false);
    }
  };

  const busy = dlState.phase === "downloading" || opening;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          shape="square"
          aria-label={`更多操作 ${name}`}
          title="更多操作"
          data-testid="workbench-file-overflow"
          disabled={busy}
          className="shrink-0"
        >
          {busy ? <Spinner size={14} /> : <MoreHorizontal size={15} />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="z-[70] min-w-[10rem]">
        <DropdownMenuItem onSelect={() => void copyPath()}>
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} className="text-muted" />}
          <span>{copied ? "已复制路径" : "复制路径"}</span>
        </DropdownMenuItem>
        {isContainerFile && (
          <DropdownMenuItem disabled={dlState.phase === "downloading"} onSelect={() => void startDownload()}>
            <Download size={14} className="text-muted" />
            <span>下载 {name}</span>
          </DropdownMenuItem>
        )}
        {isContainerFile && showOpenInNewWindow && (
          <DropdownMenuItem disabled={opening} onSelect={() => void openInNewWindow()}>
            <ExternalLink size={14} className="text-muted" />
            <span>新窗口打开</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type WorkbenchBottomBarProps = {
  /** 幻灯片翻页控件（仅 Slides 模式传入）。 */
  slide?: {
    page: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
  /** 文档大纲切换入口（仅长文档模式且存在标题时传入）。 */
  outline?: {
    count: number;
    open: boolean;
    onToggle: () => void;
  };
  /** 幻灯片 / 文档模式切换。 */
  modeToggle?: {
    label: string;
    icon: "doc" | "slides";
    onClick: () => void;
    testId?: string;
  };
  /** 左侧额外自定义紧凑控件（如紧凑视图切换）。 */
  leading?: ReactNode;
  /** 右侧次级操作（通常为 FileOverflowMenu）。 */
  trailing?: ReactNode;
  /** 唯一批注主按钮。 */
  annotate?: {
    label?: string;
    ariaLabel?: string;
    active?: boolean;
    onClick: () => void;
    testId?: string;
  };
  className?: string;
};

export function WorkbenchBottomBar({
  slide,
  outline,
  modeToggle,
  leading,
  trailing,
  annotate,
  className,
}: WorkbenchBottomBarProps) {
  return (
    <div className={cn("wb-bottom-bar", className)} data-testid="workbench-bottom-bar">
      {slide && (
        <div className="oc-surface-recessed flex shrink-0 items-center gap-0.5 rounded-lg p-0.5">
          <IconButton
            size="sm"
            shape="square"
            aria-label="上一页"
            title="上一页 (←)"
            disabled={slide.page <= 1}
            onClick={slide.onPrev}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <span
            className="px-2 text-caption font-semibold tabular-nums text-fg whitespace-nowrap"
            data-testid="slide-counter"
          >
            <span className="sr-only sm:not-sr-only">第 </span>
            {slide.page} / {slide.total}
            <span className="sr-only sm:not-sr-only"> 页</span>
          </span>
          <IconButton
            size="sm"
            shape="square"
            aria-label="下一页"
            title="下一页 (→)"
            disabled={slide.page >= slide.total}
            onClick={slide.onNext}
          >
            <ChevronRight size={15} />
          </IconButton>
        </div>
      )}

      {outline && (
        <Button
          type="button"
          size="sm"
          variant={outline.open ? "secondary" : "ghost"}
          aria-expanded={outline.open}
          onClick={outline.onToggle}
          data-testid="doc-outline-toggle"
          className="h-8 shrink-0 px-2 text-meta whitespace-nowrap"
        >
          <ListTree size={13} aria-hidden />
          <span>目录</span>
          <span className="tabular-nums text-faint">({outline.count})</span>
        </Button>
      )}

      {modeToggle && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={modeToggle.onClick}
          data-testid={modeToggle.testId}
          className="h-8 shrink-0 px-2 text-meta whitespace-nowrap"
        >
          {modeToggle.icon === "doc" ? (
            <BookOpen size={13} aria-hidden />
          ) : (
            <Presentation size={13} aria-hidden />
          )}
          <span>{modeToggle.label}</span>
        </Button>
      )}

      {leading}

      <span className="min-w-1 flex-1" />

      {trailing}

      {annotate && (
        <Button
          type="button"
          size="sm"
          variant={annotate.active ? "accent" : "secondary"}
          aria-label={annotate.ariaLabel}
          onClick={annotate.onClick}
          data-testid={annotate.testId ?? "deliverable-annotate-trigger"}
          className="h-8 shrink-0 gap-1.5 px-2.5 text-meta font-medium whitespace-nowrap"
        >
          <PencilLine size={13} aria-hidden />
          <span>{annotate.label ?? "批注修改"}</span>
        </Button>
      )}
    </div>
  );
}

export function AnnotationComposer({
  filePath,
  fileName,
  category,
  anchor,
  excerpt,
  hasComposerBridge,
  docked = false,
  onClearAnchor,
  onClose,
  onSubmitPrompt,
}: {
  filePath: string;
  fileName: string;
  category: DeliverableMeta["category"];
  anchor: AnnotationAnchor;
  excerpt?: string;
  hasComposerBridge: boolean;
  docked?: boolean;
  onClearAnchor: () => void;
  onClose: () => void;
  onSubmitPrompt: (prompt: string) => Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const trimmed = comment.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const prompt = buildAnnotationPrompt({
        filePath,
        fileName,
        category,
        anchor,
        comment: trimmed,
        excerpt,
      });
      const ok = await onSubmitPrompt(prompt);
      if (ok) {
        setComment("");
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className={cn("wb-annotate-box", docked && "wb-annotate-box-docked")} data-testid="deliverable-annotate-box">
      <div className="wb-annotate-header">
        <span className="wb-anchor-chip" data-testid="deliverable-annotate-anchor">
          定位：{formatAnchorLabel(anchor)}
        </span>
        {anchor.kind !== "file" && (
          <button
            type="button"
            onClick={onClearAnchor}
            className="rounded px-1.5 py-0.5 text-caption text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            改为整份文件
          </button>
        )}
        <span className="flex-1" />
        <IconButton aria-label="关闭批注输入框" size="sm" shape="square" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="写下你的精修要求（例如：精简要点、修正该行数据、补充对比结论…）"
        aria-label="批注修改要求"
        data-testid="deliverable-annotate-input"
        className="wb-annotate-input text-base md:text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-caption text-faint">
          <kbd className="oc-kbd">⌘ / Ctrl</kbd>
          <span>+</span>
          <kbd className="oc-kbd">Enter</kbd>
          <span>快捷提交</span>
        </span>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={!comment.trim() || submitting}
            onClick={() => void handleSubmit()}
            data-testid="deliverable-annotate-submit"
          >
            <Send size={12} aria-hidden />
            {hasComposerBridge ? "回填到输入框" : "复制批注指令"}
          </Button>
        </div>
      </div>
    </div>
  );
}
