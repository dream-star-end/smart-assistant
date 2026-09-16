import * as Dialog from "@radix-ui/react-dialog";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@openclaude/protocol";
import type { MessageReplyQuote } from "@openclaude/protocol";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import {
  ArrowUp,
  FileText,
  ListPlus,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Target,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useComposerDraft } from "../hooks/useComposerDraft";
import { apiErrorMessage } from "../lib/api";
import { appUpdate } from "../lib/appUpdate";
import { BRAND } from "../lib/brand";
import { clearDraft, draftExceedsStorage } from "../lib/composerDraft";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import { useImageEditActions } from "./chat/imageEditActions";
import { GoalDialog, STATUS_LABEL, goalNearBudget, visibleGoalOf, type GoalSetInput } from "./GoalDialog";
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
  iconButtonVariants,
  useToast,
} from "./ui";

// Captured by one upload, not keyed by the reusable "new" draft name. Promotion
// moves this exact attachment's owner without redirecting future new drafts.
type AttachOwner = { key: string | undefined; epoch: number };
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

type OwnedAttach = Attach & { owner: AttachOwner };
const attachmentCache = new Map<string, OwnedAttach[]>();
let attachEpoch = 0;
let nextAttachId = 0;

/** Same-session identity promotion only. Ordinary session/account switches must not call this. */
export function moveComposerAttachments(from: string, to: string): void {
  if (!from || !to || from === to) return;
  const moving = attachmentCache.get(from) ?? [];
  const dest = attachmentCache.get(to) ?? [];
  for (const item of moving) item.owner.key = to;
  attachmentCache.set(to, dest.length ? [...dest, ...moving] : moving);
  attachmentCache.delete(from);
}

export function resetComposerAttachmentCache(): void {
  for (const items of attachmentCache.values()) {
    for (const a of items) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
  }
  attachmentCache.clear();
  attachEpoch += 1;
}

function clipboardImages(data: DataTransfer): File[] {
  const itemImages = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null);
  if (itemImages.length > 0) return itemImages;
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

/** 时间假进度的预期时长;超过后不再假装「快好了」,切成不确定态(C-09)。 */
export const ENV_PREP_EXPECTED_MS = 20_000;
/** 语音错误提示的常驻时长(C-19):3s 来不及读完,改 6s 且下一次点麦克风即清除。 */
export const VOICE_MSG_TTL_MS = 6_000;

function EnvironmentPrepBar() {
  const [pct, setPct] = useState(8);
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Date.now() - started;
      const next = Math.min(100, 8 + (elapsed / ENV_PREP_EXPECTED_MS) * 92);
      setPct(next);
      if (elapsed >= ENV_PREP_EXPECTED_MS) {
        // 冷启超过预期:进度条停在 100% 却写着「约 20 秒」是失真信号,改为不确定态脉动 + 诚实文案。
        setOverdue(true);
        window.clearInterval(id);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      className="px-4 pt-3"
      data-testid="composer-env-prep"
      data-overdue={overdue ? "true" : "false"}
      role="status"
      aria-live="polite"
    >
      <div className="mb-1.5 text-meta text-muted">
        {overdue ? "仍在准备环境，请稍候…" : "环境准备中，约 20 秒"}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hover" aria-hidden>
        <div
          className={cn(
            "h-full rounded-full bg-accent transition-[width] duration-200",
            overdue && "animate-pulse",
          )}
          style={{ width: overdue ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Composer({
  onSend,
  busy,
  stopping,
  onStop,
  disabled,
  banner,
  // 品牌名取 lib/brand 单一权威,不写死(M-16)。
  placeholder = `给${BRAND.name}发消息…`,
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
  environmentPreparing,
  sendKey = "enter",
  fontSize = "default",
  lastUserText,
  draftKey,
  goalOpenRequest,
}: {
  /** 发送：当前正文 + 可选已上传媒体 + 可选精确引用快照。 */
  onSend: (text: string, media?: MediaRef[], replyTo?: MessageReplyQuote) => void;
  busy?: boolean;
  /** The same send/stop control is settling an acknowledged Stop. */
  stopping?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  /** 状态横幅插槽(渲染在输入框上方,Composer 根容器内)。移动端软键盘压缩视口时,
   *  外部流式布局里的横幅会被顶出可视区;挪进 Composer 让它钉在输入框旁始终可见。 */
  banner?: ReactNode;
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
  /** 容器冷启/未就绪：输入区展示「环境准备中，约 20 秒」进度条，避免静默等待。 */
  environmentPreparing?: boolean;
  /** 发送快捷键：enter = Enter 发送（⌘+Enter 保持发送）；mod-enter = ⌘/Ctrl+Enter 发送。 */
  sendKey?: "enter" | "mod-enter";
  /** 输入框字号。large 时 17.5px。 */
  fontSize?: "default" | "large";
  /** 时间线最后一条用户正文；空输入框按 ↑ 填入。 */
  lastUserText?: string;
  /** 会话级草稿键；切换时只还原该会话自己的草稿。 */
  draftKey?: string;
  /** 外部请求打开目标对话框：nonce 变化即打开（与 prefill 同模式）。 */
  goalOpenRequest?: number;
}) {
  // 图片编辑入口收口到 ImageEditActionsContext 单一权威(与聊天内图同源门控),
  // 不再经 App→Composer prop 平行下传 onAnnotateImage/reason(消除并行机制)。
  const { annotate, annotateUnavailableReason } = useImageEditActions();
  const [value, setValue] = useComposerDraft(draftKey);
  // 指针类型:粗指针(触屏/移动)下 Enter=换行(否则打不出多段消息),发送交给按钮;
  // 细指针(桌面鼠标)下 Enter=发送。指针类型运行期几乎不变,挂载读一次即可;
  // matchMedia 缺省(jsdom/SSR)回退细指针,保持桌面「Enter 发送」既有行为与测试稳定。
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  const [attach, setAttach] = useState<{ key: string | undefined; items: OwnedAttach[] }>(() => ({
    key: draftKey,
    items: draftKey ? (attachmentCache.get(draftKey) ?? []) : [],
  }));
  const attachEpochRef = useRef(attachEpoch);
  if (attach.key !== draftKey || attachEpochRef.current !== attachEpoch) {
    const cacheWasReset = attachEpochRef.current !== attachEpoch;
    // Every mutation already updates the cache. Re-saving old React state here
    // would resurrect the old name after an explicit identity promotion.
    attachEpochRef.current = attachEpoch;
    const items = draftKey && !cacheWasReset ? (attachmentCache.get(draftKey) ?? []) : [];
    setAttach({ key: draftKey, items });
  }
  const attachments = attach.items;
  // 附件件数的同步镜像(C-22):onFiles 若读渲染闭包里的 attachments.length,同一帧内连续两次拖放
  // 会用同一个旧值算 room,合计可超 MAX_ATTACH(后端才拒)。每次渲染回写真值,onFiles 内就地累加。
  const attachCountRef = useRef(attachments.length);
  attachCountRef.current = attachments.length;
  const setAttachments = (next: SetStateAction<OwnedAttach[]>) => {
    setAttach((curr) => {
      const items = typeof next === "function" ? next(curr.items) : next;
      if (curr.key) attachmentCache.set(curr.key, items);
      return items === curr.items ? curr : { ...curr, items };
    });
  };
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  // 目标对话框开合:入口从会话头部迁至「+」菜单后,由 Composer 持有开合态(菜单项触发打开)。
  const [goalOpen, setGoalOpen] = useState(false);
  useEffect(() => {
    if (!goalOpenRequest) return;
    setGoalOpen(true);
  }, [goalOpenRequest]);
  // 「+」菜单受控开合:附件项须在 onSelect 里 preventDefault 阻止 Radix 同步关菜单
  // (卸载会杀掉 label 的原生激活,见附件项注释),菜单关闭改由我们在宏任务里手动触发。
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const toast = useToast();
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 附件 file input 的稳定 id：供工具条回形针 <label htmlFor> 原生激活。
  const fileInputId = useId();
  // 已创建的 object URL 集合：卸载时统一 revoke（state 闭包在 cleanup 里是 stale，靠 ref 兜底）。
  const objectUrlsRef = useRef<Set<string>>(new Set());

  // 版本握手 busy 探针:有未发送草稿/附件 → 软刷新推迟。正文草稿按 draftKey 写入
  // sessionStorage,但附件/引用仍只在内存,reload 会丢。
  const draftBusyRef = useRef(false);
  draftBusyRef.current = value.trim().length > 0 || attachments.length > 0 || !!replyTo;
  useEffect(() => appUpdate.registerBusyProbe(() => draftBusyRef.current), []);

  const makePreview = useCallback((file: File): string => {
    const u = URL.createObjectURL(file);
    objectUrlsRef.current.add(u);
    return u;
  }, []);
  const revoke = useCallback((u?: string) => {
    if (u) {
      URL.revokeObjectURL(u);
      objectUrlsRef.current.delete(u);
    }
  }, []);
  // 卸载：revoke 本实例创建且已不在模块 cache 里的 object URL（cache 跨 remount 仍有效）。
  useEffect(
    () => () => {
      const cached = new Set<string>();
      for (const items of attachmentCache.values()) {
        for (const a of items) {
          if (a.previewUrl) cached.add(a.previewUrl);
        }
      }
      for (const u of objectUrlsRef.current) {
        if (!cached.has(u)) URL.revokeObjectURL(u);
      }
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
  // 语音错误此前 3s 就消失、且不走 live region,读屏听不到、肉眼也来不及读完(C-19):
  // 改为 6s 或下一次点麦克风时清除,并在底部以 role=status 播报。
  const voiceMsgTimerRef = useRef<number | null>(null);
  const onVoiceErr = useCallback((m: string) => {
    setVoiceMsg(m);
    if (voiceMsgTimerRef.current !== null) window.clearTimeout(voiceMsgTimerRef.current);
    voiceMsgTimerRef.current = window.setTimeout(() => {
      voiceMsgTimerRef.current = null;
      setVoiceMsg(null);
    }, VOICE_MSG_TTL_MS);
  }, []);
  useEffect(
    () => () => {
      if (voiceMsgTimerRef.current !== null) window.clearTimeout(voiceMsgTimerRef.current);
    },
    [],
  );
  const voice = useVoiceInput({ getToken: getVoiceToken, onText: onVoiceText, onError: onVoiceErr });
  const voiceEnabled = voice.supported && !!getVoiceToken;
  // 不可用原因要说得出来(C-20):触屏没有 hover title,灰掉的麦克风等于没解释。
  const voiceUnavailableReason = !voice.supported
    ? "当前浏览器不支持语音输入，请用 HTTPS 打开并允许使用麦克风"
    : !getVoiceToken
      ? "语音输入需登录后在正式会话中使用"
      : null;
  const onVoiceClick = () => {
    if (voiceUnavailableReason) {
      toast(voiceUnavailableReason, "info");
      return;
    }
    if (voiceMsgTimerRef.current !== null) {
      window.clearTimeout(voiceMsgTimerRef.current);
      voiceMsgTimerRef.current = null;
    }
    setVoiceMsg(null);
    voice.toggle();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [value]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const attachFailed = attachments.some((a) => a.status === "error");
  const doneMedia = attachments
    .filter((a) => a.status === "done" && a.media)
    .map((a) => a.media as MediaRef);
  // error 与 uploading 同等拦截：失败附件不得被静默丢掉后把正文发出去。
  const canSend = (value.trim().length > 0 || doneMedia.length > 0) && !uploading && !attachFailed;
  // 草稿超过 sessionStorage 上限后只留内存、刷新即丢,此前没有任何预警(C-21)。
  const draftVolatile = !!draftKey && draftExceedsStorage(value);

  // 「+」菜单只保留目标(有 onSetGoal+onGoalAction)。附件已提到工具条一级回形针。
  // 无目标时(如 demo)退化为禁用的「+」按钮,保留原视觉锚点而不弹空菜单。
  const canAttach = !!onUpload;
  const canGoal = !!onSetGoal && !!onGoalAction;
  const hasPlusMenu = canGoal;
  const visibleGoal = visibleGoalOf(goal);

  const removeAttach = useCallback(
    (id: string) => {
      setAttach((curr) => {
        const hit = curr.items.find((x) => x.id === id);
        if (hit) revoke(hit.previewUrl);
        const items = curr.items.filter((x) => x.id !== id);
        if (curr.key) attachmentCache.set(curr.key, items);
        return { ...curr, items };
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
    if (draftKey) clearDraft(draftKey);
    for (const a of attachments) revoke(a.previewUrl);
    setAttachments([]);
    onCancelReply?.();
  };

  // 单文件上传（首传与「重试」共用）：置 uploading（清旧错误）→ onUpload → done / error。
  // 复用原 File 对象，重试无需重选文件；成功后携带 media，供 doneMedia 汇总发送。
  const uploadOne = useCallback(
    async (id: string, file: File, owner: AttachOwner) => {
      if (!onUpload) return;
      const apply = (mapFn: (items: OwnedAttach[]) => OwnedAttach[]) => {
        setAttach((curr) => {
          if (owner.epoch !== attachEpoch) return curr;
          const target = owner.key;
          if (curr.key === target) {
            const items = mapFn(curr.items);
            if (curr.key) attachmentCache.set(curr.key, items);
            return { ...curr, items };
          }
          if (target) attachmentCache.set(target, mapFn(attachmentCache.get(target) ?? []));
          return curr;
        });
      };
      apply((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: "uploading", error: undefined } : a)),
      );
      try {
        const media = await onUpload(file);
        apply((prev) => prev.map((a) => (a.id === id ? { ...a, status: "done", media } : a)));
      } catch (e) {
        apply((prev) =>
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
    const room = Math.max(0, MAX_ATTACH - attachCountRef.current);
    const arr = picked.slice(0, room);
    const dropped = picked.length - arr.length;
    if (dropped > 0) toast(`最多 ${MAX_ATTACH} 个附件,已忽略 ${dropped} 个`, "info");
    attachCountRef.current += arr.length;
    for (const file of arr) {
      const id = `att-${nextAttachId++}`;
      const owner: AttachOwner = { key: draftKey, epoch: attachEpoch };
      const kind = mediaKindOf(file.type);
      // 图片:选中即生成本地预览 URL（无需等上传完成，chip 立刻显缩略图、可点开看大图）。
      const previewUrl = kind === "image" ? makePreview(file) : undefined;
      // 持有原始 File：失败后「重试」复用它原地重传，多文件混合状态各 chip 独立重试。
      setAttachments((prev) => [
        ...prev,
        { id, owner, name: file.name, size: file.size, kind, status: "uploading", previewUrl, file },
      ]);
      void uploadOne(id, file, owner);
    }
  };

  const canAcceptDrop = !disabled && !busy && !!onUpload;
  const isFileDrag = (e: { dataTransfer: DataTransfer | null }) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

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
      {banner}
      {visibleGoal && canGoal && (
        <button
          type="button"
          data-testid="composer-goal-chip"
          aria-label={`会话目标：${visibleGoal.objective}`}
          title={visibleGoal.objective}
          onClick={() => setGoalOpen(true)}
          // 触屏 44px 命中(a11y-B composer#3);桌面 28px 胶囊不变。
          className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-meta text-fg hover:bg-hover [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3.5"
        >
          <Target
            size={13}
            className={cn("shrink-0", goalNearBudget(visibleGoal) ? "text-warning" : "text-accent")}
          />
          <span className="min-w-0 truncate">{visibleGoal.objective}</span>
          <span className="shrink-0 text-muted">{STATUS_LABEL[visibleGoal.status]}</span>
        </button>
      )}
      <div
        className={cn(
          "rounded-[26px] border border-border-control bg-surface shadow-[var(--shadow-float)] transition-all",
          "focus-within:border-border-strong",
          dragActive && "ring-2 ring-ring",
        )}
        onDragEnter={(e) => {
          if (!isFileDrag(e) || !canAcceptDrop) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDragActive(true);
        }}
        onDragOver={(e) => {
          if (!isFileDrag(e)) return;
          e.preventDefault();
          if (!canAcceptDrop) {
            e.dataTransfer.dropEffect = "none";
            return;
          }
          e.dataTransfer.dropEffect = "copy";
          if (!dragActive) setDragActive(true);
        }}
        onDragLeave={(e) => {
          if (!isFileDrag(e)) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepthRef.current = 0;
          setDragActive(false);
          if (!canAcceptDrop) return;
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length > 0) void onFiles(files);
        }}
      >
        {environmentPreparing && <EnvironmentPrepBar />}
        {replyTo && (
          <div className="mx-3.5 mt-3 flex items-start gap-2 rounded-xl bg-hover px-3 py-2 text-left">
            <div className="min-w-0 flex-1 border-l-2 border-accent/60 pl-2.5">
              <div className="mb-0.5 text-caption font-medium text-muted">
                正在引用 {replyTo.role === "assistant" ? BRAND.name : "你"}
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
                  a.status === "error" && a.file
                    ? () => void uploadOne(a.id, a.file as File, a.owner)
                    : undefined
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
        {/* 两行式布局(C-01/C-14):第一行 textarea 通栏,第二行工具行(左=附件/「+」/仓库,右=状态/语音/发送)。
            此前 4 个 44px 按钮与 textarea 同排:390px 下正文只剩约 138px、每行 8 个字;桌面多行草稿时
            按钮贴底、正文左侧空出一列。桌面也统一两行,附件区/引用块与正文左沿对齐。 */}
        <div
          className="px-3 pb-2 pt-2.5"
          data-product-entry-scope="composer-primary"
          data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
        >
          <div className="flex px-1" data-testid="composer-input-row">
            <textarea
              data-product-feature={PRODUCT_CAPABILITIES.chatBasics.id}
              ref={ref}
              rows={1}
              value={value}
              disabled={disabled}
              aria-label="消息输入框"
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                if (!onUpload) return;
                const images = clipboardImages(e.clipboardData);
                if (images.length === 0) return;
                e.preventDefault();
                void onFiles(images);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" && value === "" && !e.nativeEvent.isComposing && lastUserText) {
                  e.preventDefault();
                  setValue(lastUserText);
                  requestAnimationFrame(() => {
                    const el = ref.current;
                    if (!el) return;
                    const end = lastUserText.length;
                    el.setSelectionRange(end, end);
                  });
                  return;
                }
                // 引用块只能点「×」取消(C-23):textarea 聚焦且不在生成中时 Esc 直接取消引用;
                // 生成中不拦,让全局 Esc 仍走「停止生成」(lib/hotkeys)。
                if (e.key === "Escape" && replyTo && onCancelReply && !busy && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onCancelReply();
                  return;
                }
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  // 粗指针(移动/触屏):Enter=换行,发送交给按钮 —— 否则无法输入多段消息。
                  if (coarsePointer) return;
                  const mod = e.metaKey || e.ctrlKey;
                  // enter 模式保持原行为：Enter / ⌘+Enter 都发送，仅 Shift+Enter 换行。
                  const shouldSend = sendKey === "mod-enter" ? mod : !e.shiftKey;
                  if (!shouldSend) return;
                  e.preventDefault();
                  submit();
                }
              }}
              enterKeyHint={coarsePointer ? "enter" : "send"}
              placeholder={placeholder}
              className={cn(
                "max-h-[240px] min-h-[24px] w-full flex-1 resize-none bg-transparent py-1.5 leading-relaxed text-fg outline-none placeholder:text-faint disabled:opacity-50",
                fontSize === "large" ? "text-[17.5px]" : "text-[16px]",
              )}
            />
          </div>
          <div className="mt-1 flex items-center gap-1.5" data-testid="composer-tool-row">
            {/* file input 用 sr-only(视觉隐藏但非 display:none)+ tabindex=-1,配合工具条
                <label htmlFor> 原生激活。国产内核(鸿蒙/华为/Quark)会把 display:none input 上的
                合成 click 静默吞掉,原生 label 激活是跨内核唯一可靠路径(实证 61de46e2/de16e2be)。
                不挂 accept 白名单(会灰掉国产内核选择器),类型判定与准入交给 onFiles/后端。
                禁止合成 input.click()。 */}
            <input
              data-product-feature={PRODUCT_CAPABILITIES.files.id}
              id={fileInputId}
              ref={fileRef}
              type="file"
              multiple
              tabIndex={-1}
              className="sr-only"
              // 结构红线(T4:type=file/无 accept/非 display:none/tabindex=-1)一项不动。
              aria-label="选择附件文件"
              onChange={(e) => onFiles(Array.from(e.currentTarget.files ?? []))}
            />
            {canAttach && (
              // 键盘可达(C-03):<label> 默认不在 Tab 序列,纯键盘/读屏用户无法触达附件。加 tabIndex/role,
              // Enter/Space 在 label 自身派发原生 click → 走 label 激活转发到 input(仍是原生路径,
              // 不是被禁止的合成 input.click();input 的 tabindex=-1 / 非 display:none / 无 accept 三条红线不动)。
              <label
                htmlFor={fileInputId}
                aria-label="添加附件"
                title="添加附件"
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled || undefined}
                data-product-feature={PRODUCT_CAPABILITIES.files.id}
                onKeyDown={(e) => {
                  if (disabled) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.currentTarget.click();
                  }
                }}
                className={cn(
                  iconButtonVariants({ shape: "square" }),
                  "cursor-pointer",
                  disabled && "pointer-events-none opacity-50",
                )}
              >
                <Paperclip size={18} />
              </label>
            )}
            {/* 「+」选项菜单:仅「设定目标」(附件已提到一级回形针)。
                菜单在移动端同样以触屏打开,DropdownMenu 原语已含 py-2 触控目标与向上翻转;
                无目标时(demo)退化为禁用按钮,不弹空菜单。 */}
            {hasPlusMenu ? (
              <DropdownMenu open={plusMenuOpen} onOpenChange={setPlusMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    data-product-feature={PRODUCT_CAPABILITIES.files.id}
                    aria-label="更多选项"
                    title="更多选项"
                    disabled={disabled}
                    className="relative"
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
                  {canGoal && (
                    <DropdownMenuItem
                      data-product-feature={PRODUCT_CAPABILITIES.sessionGoal.id}
                      onSelect={() => setGoalOpen(true)}
                    >
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
                // 「+」菜单早已只剩「设定目标」(附件在一级回形针),禁用态文案跟着改,不再说「附件暂不可用」(C-15)。
                title="会话目标暂不可用"
                disabled
                className="relative"
              >
                <Plus size={20} />
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
            )}
            {/* GitHub 仓库入口在 sm+ 并入工具行左侧(与附件/「+」同组,少一层视觉层级)。
                390px 下 5 个 44px 按钮(含生成中的「排队发送」)加未绑定态不可截断的「关联 GitHub 仓库」会撑爆一行
                (after 截图实测 pill 压在排队键上),窄屏仍放在外壳下方的底栏(见下)。 */}
            {onOpenRepo && (
              <span className="hidden min-w-0 items-center sm:flex" data-testid="composer-repo-slot">
                <RepoPill selection={repoSelection ?? null} onClick={onOpenRepo} />
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* 「正在停止…」占位符已由 App 传入 placeholder 承载,角落再写一遍是冗余(C-17);
                  这里只保留给读屏的状态播报,不再占视觉位。 */}
              {stopping && (
                <output className="sr-only" aria-live="polite">
                  正在停止…
                </output>
              )}
              {value.length > 2000 && (
                <span className="text-caption text-faint tabular-nums">{value.length} 字</span>
              )}
              {/* 草稿超过 20KB 只留内存、刷新丢失,此前毫无预警(C-21)。 */}
              {draftVolatile && (
                <output
                  data-testid="composer-draft-volatile"
                  className="hidden text-caption text-warning sm:inline"
                  title="草稿超过本地保存上限，只保留在内存中；刷新或关闭页面后不再恢复"
                >
                  草稿过长，刷新后不保留
                </output>
              )}
              {/* 发送键禁用原因不再只放 hover title(触屏无 hover,C-10):可见 caption + role=status。 */}
              {!busy && (attachFailed || uploading) && (
                <output
                  data-testid="composer-send-blocked-reason"
                  className={cn("text-caption", attachFailed ? "text-danger" : "text-faint")}
                >
                  {attachFailed ? "有附件上传失败" : "附件上传中…"}
                </output>
              )}
              {/* 生成中排队发送(C-02):此前生成中唯一按钮是「停止」,桌面 Enter 排队无反馈,触屏 Enter=换行
                  → 根本没有排队入口。现在 busy 且有可发内容时给一个次级「排队发送」按钮;「停止」仍是唯一
                  Stop 控件(T35),本按钮 aria-label 不含「停止」。
                  标记为控件而非 chat-basics 的教程 CTA 入口(data-product-feature):教程正文尚未描述「排队发送」,
                  新增 feature 入口会触发 check:tutorials 入口身份变化;正文补写并抬版后再恢复(q-1076)。 */}
              {busy && !stopping && canSend && !disabled && (
                <IconButton
                  data-product-control
                  aria-label="排队发送"
                  title="本轮结束后自动发送"
                  className="text-accent"
                  onClick={() => {
                    submit();
                    toast("已加入队列，本轮结束后发送", "info");
                  }}
                >
                  <ListPlus size={19} />
                </IconButton>
              )}
              {/* 不支持/未登录时不再 disabled 灰掉了事(C-20):保持可聚焦可点,点了用 toast 说明原因。 */}
              <IconButton
                data-product-feature={PRODUCT_CAPABILITIES.voice.id}
                aria-label={voice.state === "recording" ? "停止录音" : "语音输入"}
                title={voiceUnavailableReason ?? (voice.state === "recording" ? "停止录音" : "语音输入")}
                aria-disabled={voiceUnavailableReason ? true : undefined}
                data-voice-unavailable={voiceUnavailableReason ? "true" : undefined}
                disabled={disabled || voice.state === "transcribing"}
                onClick={onVoiceClick}
                className={cn(
                  voice.state === "recording" && "text-danger",
                  voiceUnavailableReason && "text-faint",
                )}
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
                title={
                  attachFailed
                    ? "有附件上传失败，请重试或移除后再发送"
                    : uploading
                      ? "附件上传中"
                      : busy && !stopping
                        ? "停止生成"
                        : undefined
                }
                onClick={() => {
                  if (busy) {
                    if (!stopping) onStop?.();
                    return;
                  }
                  submit();
                }}
                disabled={stopping || (!canSend && !busy) || disabled}
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full transition-all [@media(hover:none)]:size-11",
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
        </div>
      </div>
      {/* 窄屏底栏:GitHub 仓库入口(sm+ 已并入工具行,这里只在 <sm 渲染)。 */}
      {onOpenRepo && (
        <div className="flex min-h-[30px] items-center px-1.5 py-1.5 sm:hidden" data-testid="composer-repo-slot-mobile">
          <RepoPill selection={repoSelection ?? null} onClick={onOpenRepo} />
        </div>
      )}
      {/* 语音状态(录音/转写/错误)常驻 live region(C-19):容器随 voiceEnabled 常在、内容变化才被读屏播报;
          无内容时 sr-only 不占位。 */}
      {voiceEnabled && (
        <output
          aria-live="polite"
          data-testid="composer-voice-status"
          className={cn(
            "flex min-h-[30px] items-center justify-end px-1.5 py-1.5 text-xs",
            !voiceStatus && "sr-only",
          )}
        >
          {voiceStatus}
        </output>
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
        {a.status === "error" && (
          <output className="text-caption text-danger">{a.error || "上传失败"}</output>
        )}
      </span>
      {/* 上传失败:就地「重试」按钮(复用原 File),触屏下加高到 44px(C-04)。
          替代原来「必须删除 chip 重新选文件」的痛点。 */}
      {a.status === "error" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label={`重试上传 ${a.name}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-danger hover:bg-danger/10 [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-2.5"
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
