import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUp, FileText, Loader2, Mic, Plus, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import type { MediaRef } from "../lib/chat/frames";
import type { RepoSelection } from "../lib/types";
import { cn } from "../lib/utils";
import { RepoPill } from "./github/RepoPill";
import { IconButton, useToast } from "./ui";

type Attach = {
  id: string;
  name: string;
  size: number;
  kind: MediaRef["kind"];
  status: "uploading" | "done" | "error";
  media?: MediaRef;
  error?: string;
  /** 图片本地预览 URL（createObjectURL，选中即生成；移除/发送/卸载时 revoke 防泄漏）。 */
  previewUrl?: string;
  /** 原始 File 对象：上传失败后仍持有，供「重试」原地重传（不必删 chip 重选文件）。 */
  file?: File;
};

const MAX_ATTACH = 8;

function mediaKindOf(mime: string): MediaRef["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function Composer({
  onSend,
  busy,
  onStop,
  disabled,
  placeholder = "给 OpenClaude 发消息…",
  onUpload,
  getVoiceToken,
  prefill,
  repoSelection,
  onOpenRepo,
}: {
  /** 发送：text + 可选已上传媒体（图片/文件等）。 */
  onSend: (text: string, media?: MediaRef[]) => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** 上传单文件 → MediaRef（demo / 未登录省略 → 附件按钮禁用）。 */
  onUpload?: (file: File) => Promise<MediaRef>;
  /** 语音输入取 token（demo / 未登录省略 → 麦克风禁用）。 */
  getVoiceToken?: () => string | null;
  /** 外部预填(如「在对话中创建」模板):nonce 变化即覆盖输入框并聚焦。 */
  prefill?: { text: string; nonce: number } | null;
  /** 当前会话的 GitHub 仓库绑定（省略 onOpenRepo 则不渲染底部仓库入口，如 demo）。 */
  repoSelection?: RepoSelection | null;
  /** 打开 GitHub 仓库绑定 modal（入口在底部左侧）。 */
  onOpenRepo?: () => void;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const toast = useToast();
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  // 已创建的 object URL 集合：卸载时统一 revoke（state 闭包在 cleanup 里是 stale，靠 ref 兜底）。
  const objectUrlsRef = useRef<Set<string>>(new Set());

  const makePreview = useCallback((file: File): string => {
    const u = URL.createObjectURL(file);
    objectUrlsRef.current.add(u);
    return u;
  }, []);
  const revoke = useCallback((u?: string) => {
    if (u && objectUrlsRef.current.has(u)) {
      URL.revokeObjectURL(u);
      objectUrlsRef.current.delete(u);
    }
  }, []);
  // 卸载：revoke 全部残留 object URL。
  useEffect(
    () => () => {
      for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
      objectUrlsRef.current.clear();
    },
    [],
  );

  // 预填:nonce 变化 → 覆盖当前输入并聚焦(仅在用户显式点了「在对话中创建」时触发,
  // 不会与正常输入竞争;文本可改可删,发送权始终在用户)。
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    requestAnimationFrame(() => ref.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const onVoiceText = useCallback((text: string) => {
    setVoiceMsg(null);
    setValue((v) => (v.trim() ? `${v.trim()} ${text}` : text));
    // 回填后聚焦输入框
    setTimeout(() => ref.current?.focus(), 0);
  }, []);
  const onVoiceErr = useCallback((m: string) => {
    setVoiceMsg(m);
    setTimeout(() => setVoiceMsg(null), 3000);
  }, []);
  const voice = useVoiceInput({ getToken: getVoiceToken, onText: onVoiceText, onError: onVoiceErr });
  const voiceEnabled = voice.supported && !!getVoiceToken;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const doneMedia = attachments
    .filter((a) => a.status === "done" && a.media)
    .map((a) => a.media as MediaRef);
  const canSend = (value.trim().length > 0 || doneMedia.length > 0) && !uploading;

  const removeAttach = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const hit = prev.find((x) => x.id === id);
        if (hit) revoke(hit.previewUrl);
        return prev.filter((x) => x.id !== id);
      });
    },
    [revoke],
  );

  const submit = () => {
    if (busy || disabled || !canSend) return;
    onSend(value.trim(), doneMedia.length ? doneMedia : undefined);
    setValue("");
    for (const a of attachments) revoke(a.previewUrl);
    setAttachments([]);
  };

  // 单文件上传（首传与「重试」共用）：置 uploading（清旧错误）→ onUpload → done / error。
  // 复用原 File 对象，重试无需重选文件；成功后携带 media，供 doneMedia 汇总发送。
  const uploadOne = useCallback(
    async (id: string, file: File) => {
      if (!onUpload) return;
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "uploading", error: undefined } : a)),
      );
      try {
        const media = await onUpload(file);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "done", media } : a)));
      } catch (e) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: (e as Error).message } : a)),
        );
      }
    },
    [onUpload],
  );

  const onFiles = async (picked: File[]) => {
    if (!onUpload) return;
    if (fileRef.current) fileRef.current.value = ""; // 允许同名文件再次选择
    // webview 兜底:选择结果为空(取消/被就地清空/webview 返回空)时给出可见反馈,
    // 把"点了没反应"的静默失败变成可诊断的提示,而不是让用户以为功能坏了。
    if (picked.length === 0) {
      toast("未获取到所选文件,请重试", "info");
      return;
    }
    // 上限守卫前置:超出配额的文件**不上传**(此前 chip 有守卫但 onUpload 无条件执行 →
    // 超限文件白白上传后结果被丢弃),且截断有明确提示而非静默。
    const room = Math.max(0, MAX_ATTACH - attachments.length);
    const arr = picked.slice(0, room);
    const dropped = picked.length - arr.length;
    if (dropped > 0) toast(`最多 ${MAX_ATTACH} 个附件,已忽略 ${dropped} 个`, "info");
    for (const file of arr) {
      const id = `att-${idRef.current++}`;
      const kind = mediaKindOf(file.type);
      // 图片:选中即生成本地预览 URL（无需等上传完成，chip 立刻显缩略图、可点开看大图）。
      const previewUrl = kind === "image" ? makePreview(file) : undefined;
      // 持有原始 File：失败后「重试」复用它原地重传，多文件混合状态各 chip 独立重试。
      setAttachments((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, kind, status: "uploading", previewUrl, file },
      ]);
      void uploadOne(id, file);
    }
  };

  const voiceStatus =
    voiceMsg != null ? (
      <span className="text-danger">{voiceMsg}</span>
    ) : voice.state === "recording" ? (
      <span className="text-danger">● 正在录音，点击麦克风停止</span>
    ) : voice.state === "connecting" ? (
      <span className="text-faint">正在打开麦克风…</span>
    ) : voice.state === "transcribing" ? (
      <span className="text-faint">正在转写…</span>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div
        className={cn(
          "rounded-[26px] border border-border bg-surface shadow-[var(--shadow-float)] transition-all",
          "focus-within:border-border-strong",
        )}
      >
        {/* 附件 chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3">
            {attachments.map((a) => (
              <AttachChip
                key={a.id}
                a={a}
                onRemove={() => removeAttach(a.id)}
                onPreview={
                  a.kind === "image" && a.previewUrl
                    ? () => setPreview({ url: a.previewUrl as string, name: a.name })
                    : undefined
                }
                onRetry={
                  a.status === "error" && a.file ? () => void uploadOne(a.id, a.file as File) : undefined
                }
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 px-2.5 py-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => onFiles(Array.from(e.currentTarget.files ?? []))}
          />
          <IconButton
            aria-label="添加附件"
            title={onUpload ? "添加附件" : "附件暂不可用"}
            disabled={!onUpload || disabled}
            onClick={() => fileRef.current?.click()}
            className="mb-0.5"
          >
            <Plus size={20} />
          </IconButton>
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // 生成中 Enter 一律 no-op:流式期间打字回车是高频误触,直接停掉本轮
                // 损失整个回复。停止只留给显式按钮 / Esc。
                if (!busy) submit();
              }
            }}
            placeholder={placeholder}
            className="max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-50"
          />
          <IconButton
            aria-label={voice.state === "recording" ? "停止录音" : "语音输入"}
            title={voiceEnabled ? (voice.state === "recording" ? "停止录音" : "语音输入") : "语音输入暂不可用"}
            disabled={!voiceEnabled || disabled || voice.state === "transcribing"}
            onClick={voice.toggle}
            className={cn("mb-0.5", voice.state === "recording" && "text-danger")}
          >
            {voice.state === "transcribing" ? (
              <Loader2 size={19} className="animate-spin" />
            ) : voice.state === "recording" ? (
              <Square size={16} className="fill-current" />
            ) : (
              <Mic size={19} />
            )}
          </IconButton>
          <button
            type="button"
            aria-label={busy ? "停止" : "发送"}
            onClick={() => (busy ? onStop?.() : submit())}
            disabled={(!canSend && !busy) || disabled}
            className={cn(
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-all",
              busy
                ? "bg-fg text-bg"
                : canSend
                  ? "bg-primary text-primary-fg hover:opacity-90"
                  : "bg-hover text-faint",
            )}
          >
            {busy ? <Square size={15} className="fill-current" /> : <ArrowUp size={19} />}
          </button>
        </div>
      </div>
      {/* 底部工具条:左=GitHub 仓库绑定入口;右=语音状态(仅录音/转写时显示)。
          原「内容由 AI 生成」免责声明已移除。 */}
      {(onOpenRepo || voiceStatus) && (
        <div className="flex min-h-[30px] items-center gap-2 px-1.5 py-1.5 text-xs">
          {onOpenRepo && <RepoPill selection={repoSelection ?? null} onClick={onOpenRepo} />}
          {voiceStatus && <span className="ml-auto">{voiceStatus}</span>}
        </div>
      )}

      {/* 图片附件灯箱:点击缩略图看全图。 */}
      <Dialog.Root open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
          >
            <Dialog.Title className="sr-only">{preview?.name ?? "图片预览"}</Dialog.Title>
            {preview && (
              <img
                src={preview.url}
                alt={preview.name}
                className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-float"
              />
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭预览"
                className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full bg-surface text-fg shadow-float outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

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
}: {
  a: Attach;
  onRemove: () => void;
  /** 图片可点击预览（非图片 / 无预览 URL 时省略）。 */
  onPreview?: () => void;
  /** 上传失败重试（复用原 File 原地重传；非 error 态 / 无持有 File 时省略）。 */
  onRetry?: () => void;
}) {
  const isImage = a.kind === "image" && !!a.previewUrl;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-bg py-1.5 pr-1.5 text-[12.5px]",
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
      <span className={cn("max-w-[140px] truncate", a.status === "error" ? "text-danger" : "text-fg")}>
        {a.name}
      </span>
      {/* 上传失败:就地「重试」按钮(复用原 File),移动端触控目标 h-6 足够点按。
          替代原来「必须删除 chip 重新选文件」的痛点。 */}
      {a.status === "error" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`重试上传 ${a.name}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-danger hover:bg-danger/10"
        >
          <RotateCcw size={12} />
          重试
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${a.name}`}
        className="flex size-6 shrink-0 items-center justify-center rounded text-faint hover:text-danger"
      >
        <X size={13} />
      </button>
    </div>
  );
}
