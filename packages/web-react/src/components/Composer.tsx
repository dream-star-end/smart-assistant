import * as Dialog from "@radix-ui/react-dialog";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@openclaude/protocol";
import type { MessageReplyQuote } from "@openclaude/protocol";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { ArrowUp, FileText, Loader2, Mic, Paperclip, Pencil, Plus, RotateCcw, Square, Target, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { apiErrorMessage } from "../lib/api";
import { appUpdate } from "../lib/appUpdate";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { useImageEditActions } from "./chat/imageEditActions";
import { GoalDialog, goalNearBudget, visibleGoalOf, type GoalSetInput } from "./GoalDialog";
import type { MediaRef } from "../lib/chat/frames";
import type { RepoSelection } from "../lib/types";
import { cn } from "../lib/utils";
import { RepoPill } from "./github/RepoPill";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  useToast,
} from "./ui";

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

// 附件件数上限:与后端 gateway 帧准入共用 protocol 单一权威常量,消除历史上前端 8 / 后端 5
// 的漂移(用户挂 6-8 个上传成功却被后端拒)。
const MAX_ATTACH = MAX_ATTACHMENTS_PER_MESSAGE;

function mediaKindOf(mime: string): MediaRef["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function clipboardImages(data: DataTransfer): File[] {
  const itemImages = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null);
  if (itemImages.length > 0) return itemImages;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

export function Composer({
  onSend,
  busy,
  stopping,
  onStop,
  disabled,
  placeholder = "给从简发消息…",
  onUpload,
  getVoiceToken,
  prefill,
  repoSelection,
  onOpenRepo,
  goal,
  onSetGoal,
  onGoalAction,
  replyTo,
  onCancelReply,
}: {
  /** 发送：当前正文 + 可选已上传媒体 + 可选精确引用快照。 */
  onSend: (text: string, media?: MediaRef[], replyTo?: MessageReplyQuote) => void;
  busy?: boolean;
  /** The same send/stop control is settling an acknowledged Stop. */
  stopping?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** 上传单文件 → MediaRef（demo / 未登录省略 → 附件入口禁用）。 */
  onUpload?: (file: File) => Promise<MediaRef>;
  /** 语音输入取 token（demo / 未登录省略 → 麦克风禁用）。 */
  getVoiceToken?: () => string | null;
  /** 外部预填(如「在对话中创建」模板):nonce 变化即覆盖输入框并聚焦。 */
  prefill?: { text: string; nonce: number } | null;
  /** 当前会话的 GitHub 仓库绑定（省略 onOpenRepo 则不渲染底部仓库入口，如 demo）。 */
  repoSelection?: RepoSelection | null;
  /** 打开 GitHub 仓库绑定 modal（入口在底部左侧）。 */
  onOpenRepo?: () => void;
  /** 当前会话目标快照（驱动「+」菜单里目标项的状态点；省略 onSetGoal/onGoalAction 则不渲染目标入口，如 demo）。 */
  goal?: GoalStateSnapshot | null;
  /** 设定/更新会话目标（入口从会话头部迁至「+」菜单）。 */
  onSetGoal?: (input: GoalSetInput) => Promise<void>;
  /** 目标状态流转（暂停/继续/完成/清除）。 */
  onGoalAction?: (action: "pause" | "resume" | "complete" | "clear") => Promise<void>;
  /** 当前会话 Composer 正在引用的精确消息快照。 */
  replyTo?: MessageReplyQuote | null;
  /** 取消当前引用，不影响已输入正文和附件。 */
  onCancelReply?: () => void;
}) {
  // 图片编辑入口收口到 ImageEditActionsContext 单一权威(与聊天内图同源门控),
  // 不再经 App→Composer prop 平行下传 onAnnotateImage/reason(消除并行机制)。
  const { annotate, annotateUnavailableReason } = useImageEditActions();
  const [value, setValue] = useState("");
  // 指针类型:粗指针(触屏/移动)下 Enter=换行(否则打不出多段消息),发送交给按钮;
  // 细指针(桌面鼠标)下 Enter=发送。指针类型运行期几乎不变,挂载读一次即可;
  // matchMedia 缺省(jsdom/SSR)回退细指针,保持桌面「Enter 发送」既有行为与测试稳定。
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  const [attachments, setAttachments] = useState<Attach[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  // 目标对话框开合:入口从会话头部迁至「+」菜单后,由 Composer 持有开合态(菜单项触发打开)。
  const [goalOpen, setGoalOpen] = useState(false);
  // 「+」菜单受控开合:附件项须在 onSelect 里 preventDefault 阻止 Radix 同步关菜单
  // (卸载会杀掉 label 的原生激活,见附件项注释),菜单关闭改由我们在宏任务里手动触发。
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const toast = useToast();
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 附件 file input 的稳定 id：供「+」菜单里的 <label htmlFor> 原生激活(见下方附件项)。
  const fileInputId = useId();
  const idRef = useRef(0);
  // 已创建的 object URL 集合：卸载时统一 revoke（state 闭包在 cleanup 里是 stale，靠 ref 兜底）。
  const objectUrlsRef = useRef<Set<string>>(new Set());

  // 版本握手 busy 探针:有未发送草稿/附件 → 软刷新推迟(reload 会丢 useState 里的
  // 草稿,composer 草稿当前不持久化)。ref 镜像 state 让探针零依赖渲染闭包。
  const draftBusyRef = useRef(false);
  draftBusyRef.current = value.trim().length > 0 || attachments.length > 0 || !!replyTo;
  useEffect(() => appUpdate.registerBusyProbe(() => draftBusyRef.current), []);

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

  useEffect(() => {
    if (!replyTo) return;
    requestAnimationFrame(() => ref.current?.focus());
  }, [replyTo]);

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

  // 「+」菜单可用项:附件(有 onUpload)与目标(有 onSetGoal+onGoalAction)。两者皆无时(如 demo)
  // 退化为禁用的「+」按钮,保留原视觉锚点而不弹空菜单。
  const canAttach = !!onUpload;
  const canGoal = !!onSetGoal && !!onGoalAction;
  const hasPlusMenu = canAttach || canGoal;
  const visibleGoal = visibleGoalOf(goal);

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
    // 生成中(busy)不再拒发:发送经 WS service 的"排队"路径(status=queued),本轮结束自动
    // 发出(对标 ChatGPT/Claude),用户不再干等。并轨安全由 service 侧保证——排队项只在
    // 本会话 _sendingInFlight 清除后才真正下发,绝不 mid-turn 并发送(见 socket.dispatchPayload)。
    if (disabled || !canSend) return;
    onSend(value.trim(), doneMedia.length ? doneMedia : undefined, replyTo ?? undefined);
    setValue("");
    for (const a of attachments) revoke(a.previewUrl);
    setAttachments([]);
    onCancelReply?.();
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
          prev.map((a) => (a.id === id ? { ...a, status: "error", error: apiErrorMessage(e, "上传失败") } : a)),
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
          "rounded-[26px] border border-border-control bg-surface shadow-[var(--shadow-float)] transition-all",
          "focus-within:border-border-strong",
        )}
      >
        {replyTo && (
          <div className="mx-3.5 mt-3 flex items-start gap-2 rounded-xl bg-hover px-3 py-2 text-left">
            <div className="min-w-0 flex-1 border-l-2 border-accent/60 pl-2.5">
              <div className="mb-0.5 text-[11px] font-medium text-muted">
                正在引用 {replyTo.role === "assistant" ? "从简" : "你"}
              </div>
              <div className="line-clamp-2 whitespace-pre-wrap break-words text-[12.5px] leading-5 text-fg/75">
                {replyTo.text}
              </div>
            </div>
            <IconButton
              aria-label="取消引用"
              title="取消引用"
              size="sm"
              shape="square"
              className="shrink-0 [@media(hover:none)]:size-11"
              onClick={onCancelReply}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}
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
                onAnnotate={
                  a.kind === "image" && a.previewUrl && a.status === "done" && annotate
                    ? () => annotate({ url: a.previewUrl as string, name: a.name })
                    : undefined
                }
                annotateDisabledReason={
                  a.kind === "image" && a.status === "done" ? annotateUnavailableReason : undefined
                }
              />
            ))}
          </div>
        )}
        <div
          className="flex items-end gap-1.5 px-2.5 py-2"
          data-product-entry-scope="composer-primary"
          data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
        >
          {/* file input 用 sr-only(视觉隐藏但非 display:none)+ tabindex=-1,配合下方
              <label htmlFor> 原生激活。国产内核(鸿蒙/华为/Quark)会把 display:none input 上的
              合成 click 静默吞掉,原生 label 激活是跨内核唯一可靠路径(实证 61de46e2/de16e2be)。
              不挂 accept 白名单(会灰掉国产内核选择器),类型判定与准入交给 onFiles/后端。 */}
          <input
            data-product-feature={PRODUCT_CAPABILITIES.files.id}
            id={fileInputId}
            ref={fileRef}
            type="file"
            multiple
            tabIndex={-1}
            className="sr-only"
            onChange={(e) => onFiles(Array.from(e.currentTarget.files ?? []))}
          />
          {/* 「+」选项菜单:聚合附件上传与「设定目标」入口(目标入口由会话头部迁入)。
              菜单在移动端同样以触屏打开,DropdownMenu 原语已含 py-2 触控目标与向上翻转;
              无任何可用项时(demo)退化为禁用按钮,不弹空菜单。 */}
          {hasPlusMenu ? (
            <DropdownMenu open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  data-product-feature={PRODUCT_CAPABILITIES.files.id}
                  aria-label="更多选项"
                  title="更多选项"
                  disabled={disabled}
                  className="relative mb-0.5"
                >
                  <Plus size={20} />
                  {/* 闭合态目标可见性:有活跃目标时在触发按钮右上角显小圆点,近预算转 warning 色,
                      不点开菜单也能感知目标存在/临界(与菜单项内状态点同判定权威 goalNearBudget)。 */}
                  {visibleGoal && (
                    <span
                      aria-hidden
                      data-testid="composer-goal-dot"
                      className={cn(
                        "absolute right-1 top-1 size-1.5 rounded-full",
                        goalNearBudget(visibleGoal) ? "bg-warning" : "bg-accent",
                      )}
                    />
                  )}
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                {canAttach && (
                  // 附件项渲染为原生 <label htmlFor>：点击/触摸经浏览器原生 label 激活直接打开
                  // file input,不走合成 input.click()(国产内核/iOS Safari 会静默吞掉隐藏 input
                  // 上的合成 click,实证 61de46e2/de16e2be)。
                  // onSelect 必须 preventDefault:Radix 默认 select 会在受信点击的派发过程中同步
                  // 关菜单卸载 Portal,而 label 的原生转发(post-dispatch activation)发生在派发
                  // 完成之后——届时 label 已 detached,htmlFor 解析不到 input,选择器不弹
                  // (真机 Chromium 实证 0 转发;jsdom fireEvent 是非受信事件不同步 flush,测不出)。
                  // 菜单关闭改在宏任务里手动触发:排在原生激活之后,选择器已拉起,关菜单不影响。
                  <DropdownMenuItem
                    asChild
                    data-product-feature={PRODUCT_CAPABILITIES.files.id}
                    onSelect={(e) => {
                      e.preventDefault();
                      setTimeout(() => setPlusMenuOpen(false), 0);
                    }}
                  >
                    <label htmlFor={fileInputId}>
                      <Paperclip size={16} className="shrink-0 text-muted" />
                      添加附件
                    </label>
                  </DropdownMenuItem>
                )}
                {canGoal && (
                  <DropdownMenuItem onSelect={() => setGoalOpen(true)}>
                    <Target size={16} className="shrink-0 text-muted" />
                    <span className="flex-1">{visibleGoal ? "目标" : "设定目标"}</span>
                    {visibleGoal && (
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          goalNearBudget(visibleGoal) ? "bg-warning" : "bg-accent",
                        )}
                      />
                    )}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <IconButton
              data-product-feature={PRODUCT_CAPABILITIES.files.id}
              aria-label="更多选项"
              title="附件暂不可用"
              disabled
              className="mb-0.5"
            >
              <Plus size={20} />
            </IconButton>
          )}
          <textarea
            data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            onPaste={(e) => {
              if (!onUpload) return;
              const images = clipboardImages(e.clipboardData);
              if (images.length === 0) return;
              e.preventDefault();
              void onFiles(images);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                // 粗指针(移动/触屏):Enter=换行,发送交给按钮 —— 否则无法输入多段消息。
                if (coarsePointer) return;
                e.preventDefault();
                submit();
              }
            }}
            enterKeyHint={coarsePointer ? "enter" : "send"}
            placeholder={placeholder}
            className="max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-50"
          />
          <IconButton
            data-product-feature={PRODUCT_CAPABILITIES.voice.id}
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
            data-product-control
            aria-label={stopping ? "正在停止" : busy ? "停止" : "发送"}
            onClick={() => {
              if (busy) {
                if (!stopping) onStop?.();
                return;
              }
              submit();
            }}
            disabled={stopping || (!canSend && !busy) || disabled}
            className={cn(
              "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-all",
              busy
                ? "bg-fg text-bg"
                : canSend
                  ? "bg-primary text-primary-fg hover:opacity-90"
                  : "bg-hover text-faint",
            )}
          >
            {stopping ? (
              <Loader2 size={17} className="animate-spin" />
            ) : busy ? (
              <Square size={15} className="fill-current" />
            ) : (
              <ArrowUp size={19} />
            )}
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

      {/* 会话目标对话框:由「+」菜单里的目标项打开(入口自会话头部迁入,功能本身不变)。 */}
      {canGoal && onSetGoal && onGoalAction && (
        <GoalDialog
          open={goalOpen}
          onOpenChange={setGoalOpen}
          goal={goal}
          onSet={onSetGoal}
          onAction={onGoalAction}
        />
      )}
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
      {(onAnnotate || annotateDisabledReason) && (
        <button
          type="button"
          onClick={onAnnotate}
          disabled={!onAnnotate}
          aria-label={`编辑图片 ${a.name}`}
          title={annotateDisabledReason ?? "编辑 · Image 2"}
          className="flex h-8 min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-35 sm:min-h-8"
        >
          <Pencil size={14} />
          编辑
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
