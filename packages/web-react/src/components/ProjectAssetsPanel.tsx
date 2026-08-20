import {
  Download,
  File,
  FileArchive,
  FileText,
  Film,
  Image as ImageIcon,
  MoreHorizontal,
  Music,
  Pin,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import { useSignedDownload } from "./chat/media";
import { formatBytes } from "../lib/chat/download";
import type { AuthSession, ProjectAsset, Session } from "../lib/types";
import { cn } from "../lib/utils";
import { PINNED_INJECT_LIMIT, useProjectAssets } from "../hooks/useProjectAssets";
import {
  Alert,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  ListSkeleton,
  Switch,
  TimeAgo,
  useConfirm,
  usePrompt,
} from "./ui";

export function ProjectAssetsPanel(props: {
  projectId: string | null;
  demo?: boolean;
  auth: AuthSession | null;
  authSession: AuthSession;
  sessions?: Pick<Session, "id" | "title">[];
  onOpenSession?: (sessionId: string) => void;
}): ReactElement {
  const { projectId, demo = false, auth, authSession, sessions, onOpenSession } = props;
  const [confirmDialog, confirmEl] = useConfirm();
  const [promptText, promptEl] = usePrompt();
  const {
    assets,
    loading,
    error,
    uploading,
    reload,
    uploadFiles,
    setPinned,
    renameAsset,
    deleteAsset,
  } = useProjectAssets({
    projectId,
    demo,
    auth,
    authSession,
    confirmDialog,
    promptText,
  });

  const pinnedCount = assets.filter((a) => a.pinned).length;
  const injected = Math.min(pinnedCount, PINNED_INJECT_LIMIT);
  const titleById = useMemo(
    () => new Map((sessions ?? []).map((s) => [s.id, s.title])),
    [sessions],
  );

  return (
    <div className="flex flex-col gap-4">
      {confirmEl}
      {promptEl}

      <p className="text-meta text-muted">
        设为项目知识的资料，其索引会注入该项目下所有会话。
      </p>

      <div className="flex flex-wrap items-center gap-2 text-meta">
        <span className="tabular-nums text-fg">
          已注入 {injected}/{PINNED_INJECT_LIMIT}
        </span>
        {pinnedCount > PINNED_INJECT_LIMIT ? (
          <span className="text-warning">超过 {PINNED_INJECT_LIMIT} 条时只注入前 {PINNED_INJECT_LIMIT} 条</span>
        ) : null}
      </div>

      <UploadDropzone uploading={uploading} onFiles={(files) => void uploadFiles(files)} />

      {error ? (
        <Alert
          tone="danger"
          density="compact"
          action={
            <Button variant="secondary" size="sm" onClick={reload}>
              重试
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}

      {loading ? (
        <ListSkeleton rows={4} />
      ) : assets.length === 0 && !error ? (
        <EmptyState
          icon={File}
          title="还没有资产"
          hint="上传参考资料，或在会话里生成文件后会出现在这里。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {assets.map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              sessionTitle={asset.sessionId ? titleById.get(asset.sessionId) : undefined}
              onOpenSession={onOpenSession}
              onPin={(pinned) => void setPinned(asset.id, pinned).catch(() => undefined)}
              onRename={() => void renameAsset(asset).catch(() => undefined)}
              onDelete={() => void deleteAsset(asset).catch(() => undefined)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadDropzone({
  uploading,
  onFiles,
}: {
  uploading: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const takeFiles = (list: FileList | File[] | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  const onDragOver = (e: DragEvent) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    setDragOver(true);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="上传参考资料"
      aria-busy={uploading}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        takeFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        dragOver ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-hover/40 text-muted hover:border-accent hover:bg-hover",
        uploading && "pointer-events-none opacity-70",
      )}
    >
      <Upload size={18} className="shrink-0" />
      <span className="text-body">
        {uploading ? "正在上传…" : "点击或拖拽文件到此处上传"}
      </span>
      <span className="text-caption text-faint">可一次选择多个文件，单个失败不影响其它</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          takeFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function AssetRow({
  asset,
  sessionTitle,
  onOpenSession,
  onPin,
  onRename,
  onDelete,
}: {
  asset: ProjectAsset;
  sessionTitle?: string;
  onOpenSession?: (sessionId: string) => void;
  onPin: (pinned: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const src = asset.containerPath || asset.url;
  const { state, start, cancel } = useSignedDownload(src, asset.name);
  const pinLabel = asset.pinned ? "取消项目知识" : "设为项目知识";

  return (
    <li
      data-asset-id={asset.id}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3",
        asset.pinned && "border-accent/40 bg-accent-soft/40",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-muted"
        >
          <FileKindIcon mime={asset.mime} name={asset.name} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-body font-medium text-fg">{asset.name}</span>
            <Badge size="sm" tone={asset.source === "upload" ? "info" : "accent"}>
              {asset.source === "upload" ? "上传" : "产出"}
            </Badge>
            {asset.pinned ? (
              <Badge size="sm" tone="accent">
                <Pin size={10} /> 已注入
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-faint">
            <span>{formatBytes(asset.sizeBytes) || "大小未知"}</span>
            <TimeAgo value={asset.createdAt} className="text-caption text-faint" />
            {asset.source === "output" && asset.sessionId ? (
              onOpenSession ? (
                <button
                  type="button"
                  className="min-h-11 text-left text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                  onClick={() => onOpenSession(asset.sessionId!)}
                >
                  {sessionTitle || "来源会话"}
                </button>
              ) : (
                <span>{sessionTitle || "来源会话"}</span>
              )
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 pr-1 sm:min-h-0">
          <span className="text-caption text-muted sm:sr-only">{pinLabel}</span>
          <Switch
            checked={asset.pinned}
            onCheckedChange={onPin}
            aria-label={pinLabel}
          />
        </label>
        <DownloadControl
          filename={asset.name}
          disabled={!src}
          state={state.phase}
          onStart={() => void start()}
          onCancel={cancel}
          className="hidden sm:inline-flex"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              aria-label={`${asset.name} 操作`}
              variant="muted"
              size="sm"
              shape="square"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={!src}
              className="[@media(hover:none)]:min-h-11"
              onSelect={() => void start()}
            >
              下载
            </DropdownMenuItem>
            <DropdownMenuItem className="[@media(hover:none)]:min-h-11" onSelect={onRename}>
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              className="[@media(hover:none)]:min-h-11"
              onSelect={onDelete}
            >
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function DownloadControl({
  filename,
  disabled,
  state,
  onStart,
  onCancel,
  className,
}: {
  filename: string;
  disabled: boolean;
  state: "idle" | "downloading" | "error";
  onStart: () => void;
  onCancel: () => void;
  className?: string;
}) {
  if (state === "downloading") {
    return (
      <IconButton aria-label="取消下载" variant="muted" size="sm" shape="square" className={className} onClick={onCancel}>
        <span className="text-caption">…</span>
      </IconButton>
    );
  }
  return (
    <IconButton
      aria-label={state === "error" ? `重试下载 ${filename}` : `下载 ${filename}`}
      variant="muted"
      size="sm"
      shape="square"
      disabled={disabled}
      className={className}
      onClick={onStart}
    >
      <Download size={15} />
    </IconButton>
  );
}

function FileKindIcon({ mime, name }: { mime: string | null; name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const m = mime ?? "";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) {
    return <ImageIcon size={16} />;
  }
  if (m.startsWith("video/") || ["mp4", "webm", "mov"].includes(ext)) {
    return <Film size={16} />;
  }
  if (m.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a"].includes(ext)) {
    return <Music size={16} />;
  }
  if (m === "application/pdf" || ext === "pdf") {
    return <FileText size={16} />;
  }
  if (m.includes("zip") || ["zip", "tar", "gz", "tgz", "7z"].includes(ext)) {
    return <FileArchive size={16} />;
  }
  return <File size={16} />;
}
