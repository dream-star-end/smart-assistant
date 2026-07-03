import { ArrowUp, FileText, Image as ImageIcon, Loader2, Mic, Plus, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import type { MediaRef } from "../lib/chat/frames";
import { cn } from "../lib/utils";
import { IconButton, useToast } from "./ui";

type Attach = {
  id: string;
  name: string;
  size: number;
  kind: MediaRef["kind"];
  status: "uploading" | "done" | "error";
  media?: MediaRef;
  error?: string;
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
  model,
  disabled,
  placeholder = "给 OpenClaude 发消息…",
  onUpload,
  getVoiceToken,
  prefill,
}: {
  /** 发送：text + 可选已上传媒体（图片/文件等）。 */
  onSend: (text: string, media?: MediaRef[]) => void;
  busy?: boolean;
  onStop?: () => void;
  model?: string;
  disabled?: boolean;
  placeholder?: string;
  /** 上传单文件 → MediaRef（demo / 未登录省略 → 附件按钮禁用）。 */
  onUpload?: (file: File) => Promise<MediaRef>;
  /** 语音输入取 token（demo / 未登录省略 → 麦克风禁用）。 */
  getVoiceToken?: () => string | null;
  /** 外部预填(如「在对话中创建」模板):nonce 变化即覆盖输入框并聚焦。 */
  prefill?: { text: string; nonce: number } | null;
}) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const toast = useToast();
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);

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

  const submit = () => {
    if (busy || disabled || !canSend) return;
    onSend(value.trim(), doneMedia.length ? doneMedia : undefined);
    setValue("");
    setAttachments([]);
  };

  // 只收已快照的 File[]——FileList 的快照在事件入口(onChange)就完成。
  // 原因:`e.target.files` 是 input 的**实时 FileList 引用**。部分手机 webview
  // (鸿蒙 ArkWeb / 华为浏览器等)在 `value=""` 时是**就地清空同一个 FileList 对象**,
  // 若把 live FileList 传进来、先清 value 再读,就读到空数组 → 一个 chip 都不插、
  // 连"已忽略"toast 都不弹、请求也不发 → 用户选完图片"附件区什么都没出现",后端亦无记录。
  // 让业务层永远拿不到 live FileList,从类型上根除这一类"先清后读"的空读 bug。
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
      setAttachments((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, kind: mediaKindOf(file.type), status: "uploading" },
      ]);
      try {
        const media = await onUpload(file);
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "done", media } : a)));
      } catch (e) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: (e as Error).message } : a)),
        );
      }
    }
  };

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
              <AttachChip key={a.id} a={a} onRemove={() => setAttachments((p) => p.filter((x) => x.id !== a.id))} />
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
      <p className="py-2 text-center text-xs text-faint">
        {voiceMsg ? (
          <span className="text-danger">{voiceMsg}</span>
        ) : voice.state === "recording" ? (
          <span className="text-danger">● 正在录音，点击麦克风停止</span>
        ) : voice.state === "connecting" ? (
          "正在打开麦克风…"
        ) : voice.state === "transcribing" ? (
          "正在转写…"
        ) : (
          <>
            {model ? `${model} · ` : ""}内容由 AI 生成，请注意甄别
          </>
        )}
      </p>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function AttachChip({ a, onRemove }: { a: Attach; onRemove: () => void }) {
  const Icon = a.kind === "image" ? ImageIcon : FileText;
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-bg px-2.5 py-1.5 text-[12.5px]",
        a.status === "error" ? "border-danger/40" : "border-border",
      )}
      title={a.status === "error" ? a.error || "上传失败" : `${a.name} · ${fmtSize(a.size)}`}
    >
      {a.status === "uploading" ? (
        <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
      ) : (
        <Icon size={14} className={cn("shrink-0", a.status === "error" ? "text-danger" : "text-muted")} />
      )}
      <span className={cn("max-w-[140px] truncate", a.status === "error" ? "text-danger" : "text-fg")}>
        {a.name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`移除 ${a.name}`}
        className="flex size-4 shrink-0 items-center justify-center rounded text-faint hover:text-danger"
      >
        <X size={13} />
      </button>
    </div>
  );
}
