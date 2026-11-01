import { uploadFailureCanContinue } from "@openclaude/protocol/browser";
import { FileText, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import type { Attach } from "./Composer";
import { cn } from "../lib/utils";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachChip({
  a,
  onRemove,
  onPreview,
  onRetry,
  onAnnotate,
  annotateDisabledReason,
}: {
  a: Attach;
  onRemove: () => void;
  /** 图片可点击预览（非图片 / 无预览 URL 时省略）。 */
  onPreview?: () => void;
  /** 上传失败重试（复用原 File 原地重传；非 error 态 / 无持有 File 时省略）。 */
  onRetry?: () => void;
  onAnnotate?: () => void;
  annotateDisabledReason?: string;
}) {
  const isImage = a.kind === "image" && !!a.previewUrl;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg border bg-bg py-1.5 pr-1.5 text-meta",
        isImage ? "pl-1.5" : "pl-2.5",
        a.status === "error" ? "border-danger/40" : "border-border",
      )}
      title={a.status === "error" ? a.error || "上传失败" : `${a.name} · ${fmtSize(a.size)}`}
    >
      {isImage ? (
        <button
          type="button"
          onClick={onPreview}
          aria-label={`预览 ${a.name}`}
          className="relative size-8 shrink-0 overflow-hidden rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={a.previewUrl} alt={a.name} className="size-full object-cover" />
          {a.status === "uploading" && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/40">
              <Loader2 size={13} className="animate-spin text-white" />
            </span>
          )}
        </button>
      ) : a.status === "uploading" ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
      ) : (
        <FileText size={14} className={cn("shrink-0", a.status === "error" ? "text-danger" : "text-muted")} />
      )}
      {/* 文件名中段截断(C-18):保留扩展名,同名不同格式的文件仍可分辨;完整名在 title。
          失败原因就地可见(C-10):触屏没有 hover,只放 title 等于没说。 */}
      <span className="flex min-w-0 flex-col">
        <span className={cn("max-w-[160px] whitespace-nowrap", a.status === "error" ? "text-danger" : "text-fg")}>
          {middleTruncate(a.name, 24)}
        </span>
        {a.status === "uploading" && typeof a.sentBytes === "number" && a.size > 0 && (
          <span className="text-caption text-faint tabular-nums">
            {Math.min(100, Math.round((a.sentBytes / a.size) * 100))}%
          </span>
        )}
        {a.status === "error" && (
          <output className="text-caption text-danger">{a.error || "上传失败"}</output>
        )}
        {a.status === "uploading" && typeof a.sentBytes === "number" && a.size > 0 && (
          <span className="relative mt-0.5 h-1 w-full overflow-hidden rounded bg-hover">
            <span
              className="absolute inset-y-0 left-0 bg-accent"
              style={{ width: `${Math.min(100, Math.round((a.sentBytes / a.size) * 100))}%` }}
            />
          </span>
        )}
      </span>
      {/* 上传失败:就地「重试」按钮(复用原 File),触屏下加高到 44px(C-04)。
          替代原来「必须删除 chip 重新选文件」的痛点。 */}
      {a.status === "error" && onRetry && uploadFailureCanContinue(a.error) && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`继续上传 ${a.name}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-danger hover:bg-danger/10 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-2.5"
        >
          <RotateCcw size={12} />
          继续
        </button>
      )}
      {(onAnnotate || annotateDisabledReason) && (
        <button
          type="button"
          onClick={onAnnotate}
          disabled={!onAnnotate}
          aria-label={`编辑图片 ${a.name}`}
          title={annotateDisabledReason ?? "编辑 · Image 2"}
          className="flex h-8 min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-meta font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-35 sm:min-h-8"
        >
          <Pencil size={14} />
          编辑
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${a.name}`}
        className="flex size-6 shrink-0 items-center justify-center rounded text-faint hover:text-danger [@media(hover:none)]:size-11"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** 文件名中段截断:超长时保留开头与结尾(含扩展名),中间用 …(C-18)。max 为字符数下限保证 ≥ 8。 */
export function middleTruncate(name: string, max = 24): string {
  const chars = Array.from(name);
  const limit = Math.max(8, max);
  if (chars.length <= limit) return name;
  const dot = name.lastIndexOf(".");
  // 扩展名(≤ 8 字符,不含点在开头的隐藏文件)整体保留在尾段。
  const ext = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : "";
  const tailLen = Math.max(ext.length + 3, Math.floor(limit / 3));
  const headLen = Math.max(1, limit - tailLen - 1);
  return `${chars.slice(0, headLen).join("")}…${chars.slice(chars.length - tailLen).join("")}`;
}
