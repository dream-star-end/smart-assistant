import {
  ArrowLeft,
  Bold,
  CloudCheck,
  Code,
  Eye,
  Heading2,
  Image as ImageIcon,
  ImageDown,
  ImagePlus,
  Link,
  List,
  ListOrdered,
  Quote,
  Send,
  ShieldCheck,
  SquarePen,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../../lib/api";
import { communityTutorialDraftIssue } from "../../../lib/tutorialStudio";
import type { AuthSession } from "../../../lib/types";
import { cn } from "../../../lib/utils";
import { Alert, Button, useToast } from "../../ui";
import { BlogChips, BlogProse, type BlogImageSource, uploadingToken } from "./BlogArticle";
import {
  BLOG_CATEGORIES,
  BLOG_IMAGE_MAX_PER_POST,
  BlogImageError,
  type BlogDraft,
  EMPTY_BLOG_DRAFT,
  type TextEdit,
  type ToolbarAction,
  applyToolbar,
  blogClock,
  blogDraftKey,
  blogEditDraftKey,
  blogImageShas,
  blogReadMinutes,
  clearBlogDraft,
  compressBlogImage,
  formatBytes,
  imageAltFromName,
  insertBlock,
  isEmptyDraft,
  loadBlogDraft,
  saveBlogDraft,
} from "./blogLib";

const TOOLBAR: Array<{ action: ToolbarAction; label: string; icon: typeof Bold }> = [
  { action: "heading", label: "小标题", icon: Heading2 },
  { action: "bold", label: "加粗", icon: Bold },
  { action: "list", label: "无序列表", icon: List },
  { action: "ordered", label: "有序列表", icon: ListOrdered },
  { action: "quote", label: "引用", icon: Quote },
  { action: "code", label: "代码", icon: Code },
  { action: "link", label: "链接", icon: Link },
];

const AUTOSAVE_MS = 5_000;

type Upload = { id: string; name: string; fromBytes: number; toBytes: number | null; percent: number };

/** 修改已投稿的帖子:published = 已公开(审核通过前线上仍是旧版)。 */
export type BlogEditTarget = { id: string; published: boolean };

export function BlogEditor({
  auth,
  seed,
  editing,
  aiReview,
  onBack,
  onSubmitted,
}: {
  auth: AuthSession;
  /** 「复制为新稿」或「修改」带进来的内容;没有就恢复本地草稿。 */
  seed?: BlogDraft;
  /** 有值 = 修改模式:提交走 revise,草稿存在这篇自己的 key 下。 */
  editing?: BlogEditTarget;
  aiReview: boolean;
  onBack: () => void;
  onSubmitted: () => void;
}) {
  const toast = useToast();
  // 草稿只存本机;同一浏览器换账号时草稿跟浏览器走(内容不含任何凭据)。修改模式的草稿按稿件分开存,
  // 不覆盖「写一篇经验」的新稿草稿;上次没提交的修改优先恢复。
  const draftKey = editing ? blogEditDraftKey(editing.id) : blogDraftKey();
  const [draft, setDraft] = useState<BlogDraft>(() =>
    editing ? (loadBlogDraft(draftKey) ?? seed ?? EMPTY_BLOG_DRAFT) : (seed ?? loadBlogDraft(draftKey) ?? EMPTY_BLOG_DRAFT),
  );
  const [savedAt, setSavedAt] = useState<Date | null>(() => {
    const stored = seed && !editing ? null : loadBlogDraft(draftKey);
    return stored ? new Date(stored.savedAt) : null;
  });
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [localUrls] = useState(() => new Map<string, string>());
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(false);

  const imageCount = blogImageShas(draft.bodyMarkdown).length + uploads.length;
  const issue = communityTutorialDraftIssue(draft) ?? (uploads.length > 0 ? "图片还在上传" : null);

  // 每 5 秒把改动存到本机;离开编辑器前再存一次。
  useEffect(() => {
    const save = () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      if (isEmptyDraft(draftRef.current)) return;
      if (saveBlogDraft(draftKey, draftRef.current)) setSavedAt(new Date());
    };
    const timer = window.setInterval(save, AUTOSAVE_MS);
    return () => {
      window.clearInterval(timer);
      save();
    };
  }, [draftKey]);

  // 卸载后迟到的上传结果不再建 object URL(清理已经跑过,建了就泄漏)。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of localUrls.values()) URL.revokeObjectURL(url);
      localUrls.clear();
    };
  }, [localUrls]);

  // 改动先同步写进 draftRef 再 setState:一次拖进多张图时,下一张的占位插入 / 替换读到的是
  // 上一张替换后的正文,而不是 React 还没渲染的旧值(Codex R1)。
  const update = (patch: Partial<BlogDraft>) => {
    dirtyRef.current = true;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  };
  const updateBody = (change: (body: string) => string) => update({ bodyMarkdown: change(draftRef.current.bodyMarkdown) });

  const currentEdit = (): TextEdit => {
    const el = textareaRef.current;
    const value = draftRef.current.bodyMarkdown;
    return {
      value,
      selectionStart: el?.selectionStart ?? value.length,
      selectionEnd: el?.selectionEnd ?? value.length,
    };
  };

  const applyEdit = (next: TextEdit) => {
    update({ bodyMarkdown: next.value });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };

  const uploadFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = BLOG_IMAGE_MAX_PER_POST - imageCount;
    if (room <= 0) {
      toast(`每篇最多 ${BLOG_IMAGE_MAX_PER_POST} 张图片`, "error");
      return;
    }
    if (images.length > room) toast(`每篇最多 ${BLOG_IMAGE_MAX_PER_POST} 张图片，只插入前 ${room} 张`, "info");
    // 占位一次性插在光标处,之后只按 token 替换:逐张插入时光标位置来自还没渲染的旧 DOM 文本,
    // 第二张会插进第一张的引用中间(Codex R1)。
    const batch = images.slice(0, room).map((file) => {
      const id = `u${Math.random().toString(36).slice(2, 10)}`;
      return { file, id, token: uploadingToken(id, file.name || "图片") };
    });
    applyEdit(insertBlock(currentEdit(), batch.map((item) => item.token).join("\n\n")));
    setUploads((current) => [
      ...current,
      ...batch.map(({ file, id }) => ({ id, name: file.name || "图片", fromBytes: file.size, toBytes: null, percent: 10 })),
    ]);
    for (const { file, id, token } of batch) {
      try {
        const compressed = await compressBlogImage(file);
        setUploads((current) =>
          current.map((u) => (u.id === id ? { ...u, toBytes: compressed.size, percent: 55 } : u)),
        );
        const uploaded = await api.uploadTutorialImage(auth, compressed);
        if (!mountedRef.current) return;
        const previous = localUrls.get(uploaded.sha256);
        if (previous) URL.revokeObjectURL(previous);
        localUrls.set(uploaded.sha256, URL.createObjectURL(compressed));
        const ref = `![${imageAltFromName(file.name || "图片")}](tutorial-blob:${uploaded.sha256})`;
        updateBody((body) => body.replace(token, ref));
      } catch (cause) {
        if (!mountedRef.current) return;
        updateBody((body) => body.replace(token, "").replace(/\n{3,}/g, "\n\n"));
        toast(cause instanceof BlogImageError ? cause.message : apiErrorMessage(cause, "图片上传失败"), "error");
      } finally {
        setUploads((current) => current.filter((u) => u.id !== id));
      }
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles([...event.dataTransfer.files]);
  };

  const saveLocal = () => {
    if (saveBlogDraft(draftKey, draft)) {
      dirtyRef.current = false;
      setSavedAt(new Date());
      toast("草稿已保存到本机", "success");
    } else {
      toast("浏览器不允许本地存储，草稿没有保存", "error");
    }
  };

  const submit = async () => {
    if (issue) {
      setError(issue);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        category: draft.category,
        bodyMarkdown: draft.bodyMarkdown.trim(),
      };
      if (editing) await api.reviseCommunityTutorial(auth, editing.id, payload);
      else await api.submitCommunityTutorial(auth, payload);
      clearBlogDraft(draftKey);
      dirtyRef.current = false;
      toast(
        editing?.published
          ? "修改已提交，审核通过后替换线上版本"
          : aiReview
            ? "已提交，AI 审核通常 1 分钟内出结果"
            : "已提交，等待管理员审核",
        "success",
      );
      onSubmitted();
    } catch (cause) {
      setError(apiErrorMessage(cause, editing ? "提交修改失败，请稍后重试" : "投稿失败，请稍后重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const source = useMemo<BlogImageSource>(() => ({ kind: "private", auth, localUrls }), [auth, localUrls]);
  const pendingPercent = useMemo(() => new Map(uploads.map((u) => [u.id, u.percent])), [uploads]);
  const activeUpload = uploads[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-3.5 py-2.5 sm:px-6 sm:py-3.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
        >
          <ArrowLeft size={15} /> 返回
        </button>
        {editing && (
          <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-fg">
            <SquarePen size={15} aria-hidden /> 修改投稿
          </span>
        )}
        <div className="flex-1" />
        <div
          role="tablist"
          aria-label="编辑或预览"
          className="flex rounded-full border border-border bg-hover p-[3px] md:hidden"
        >
          {(["edit", "preview"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mobileTab === tab}
              onClick={() => setMobileTab(tab)}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold",
                mobileTab === tab ? "bg-surface text-fg shadow-soft" : "text-muted",
              )}
            >
              {tab === "edit" ? "编辑" : "预览"}
            </button>
          ))}
        </div>
        {savedAt && (
          <span className="flex items-center gap-1.5 text-meta text-faint">
            <CloudCheck size={14} aria-hidden /> 草稿已自动保存 · {blogClock(savedAt)}
          </span>
        )}
      </div>

      {editing && (
        <div className="border-b border-border bg-info-soft px-3.5 py-2 text-[12.5px] leading-[1.6] text-fg sm:px-6" role="note">
          {editing.published
            ? "这篇已经公开。提交修改后会重新审核，审核通过前读者看到的仍是原来的版本；没通过也不影响原文。"
            : "提交修改后会重新审核。"}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
        <section
          aria-label="编辑"
          className={cn(
            "flex min-h-0 flex-col overflow-y-auto border-border bg-surface md:border-r",
            mobileTab === "preview" && "max-md:hidden",
          )}
          onDragOver={(event) => {
            if ([...event.dataTransfer.types].includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="flex flex-col gap-3 px-4 pb-1.5 pt-4 sm:px-6 sm:pt-5">
            <textarea
              aria-label="标题"
              rows={2}
              maxLength={100}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value.replace(/\n/g, "") })}
              placeholder="标题：一句话说清你做成了什么"
              className="resize-none border-0 bg-transparent p-0 text-[20px] font-bold leading-[1.35] text-fg outline-none placeholder:text-faint sm:text-[24px]"
            />
            <textarea
              aria-label="摘要"
              rows={2}
              maxLength={280}
              value={draft.summary}
              onChange={(event) => update({ summary: event.target.value })}
              placeholder="摘要：适合谁、能得到什么结果（会显示在卡片上）"
              className="resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-[14px] leading-[1.6] text-fg outline-none placeholder:text-faint focus:ring-2 focus:ring-ring"
            />
            <div className="-mt-1.5 text-right text-[11.5px] text-faint">摘要 {[...draft.summary].length}/280</div>
            <fieldset className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0 text-[12.5px] text-muted" aria-label="分类">
              分类
              {BLOG_CATEGORIES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={draft.category === option.value}
                  onClick={() => update({ category: option.value })}
                  className={cn(
                    "inline-flex h-7 items-center rounded-full border px-3.5 text-[13px] font-semibold",
                    draft.category === option.value
                      ? "border-primary bg-primary text-primary-fg"
                      : "border-border bg-surface text-muted hover:text-fg",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="no-scrollbar sticky top-0 z-[1] flex shrink-0 items-center gap-0.5 overflow-x-auto border-y border-border bg-surface px-2.5 py-2 sm:px-[18px]">
            {TOOLBAR.map(({ action, label, icon: Icon }) => (
              <button
                key={action}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => applyEdit(applyToolbar(currentEdit(), action))}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
              >
                <Icon size={15} />
              </button>
            ))}
            <span aria-hidden className="mx-1.5 h-[18px] w-px shrink-0 bg-border" />
            <button
              type="button"
              aria-label="插入图片"
              title="插入图片（也可以拖拽或粘贴）"
              onClick={() => fileRef.current?.click()}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-hover text-fg"
            >
              <ImagePlus size={15} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,image/avif"
              multiple
              hidden
              onChange={(event) => {
                void uploadFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap pl-2 text-meta text-faint">
              <ImageIcon size={14} aria-hidden /> 图片 {imageCount}/{BLOG_IMAGE_MAX_PER_POST}
            </span>
          </div>
          <div className="relative flex min-h-[320px] flex-1 flex-col px-4 pb-6 pt-3.5 sm:px-6">
            {activeUpload && (
              <div className="mb-2 inline-flex max-w-full items-center gap-2 self-start rounded-lg bg-info-soft px-2.5 py-1 text-[12.5px] text-info">
                <span className="truncate">
                  正在压缩并上传 {activeUpload.name} · {formatBytes(activeUpload.fromBytes)}
                  {activeUpload.toBytes != null ? ` → ${formatBytes(activeUpload.toBytes)} webp` : ""}
                </span>
                <span className="inline-block h-[5px] w-[90px] shrink-0 overflow-hidden rounded-full bg-info/20">
                  <i className="block h-full bg-info" style={{ width: `${activeUpload.percent}%` }} />
                </span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              aria-label="正文（Markdown）"
              value={draft.bodyMarkdown}
              maxLength={50000}
              onChange={(event) => update({ bodyMarkdown: event.target.value })}
              onPaste={onPaste}
              placeholder={"## 背景\n\n## 做法\n\n## 踩过的坑\n\n图片可以直接拖进来、粘贴，或点工具栏的图片按钮。"}
              className="min-h-[260px] flex-1 resize-none border-0 bg-transparent p-0 font-mono text-[13px] leading-[1.85] text-fg outline-none placeholder:text-faint sm:text-[13.5px]"
            />
            {dragging && (
              <div className="pointer-events-none absolute inset-x-4 bottom-5 flex flex-col items-center justify-center gap-1 rounded-2xl border-[1.5px] border-dashed border-accent bg-accent-soft p-4 text-center text-[13.5px] font-semibold text-accent sm:inset-x-6 sm:flex-row sm:gap-2.5">
                <ImageDown size={16} /> 松开即可插入图片
                <small className="font-medium text-muted">
                  支持拖拽 / 粘贴 / 点击，自动压缩为 webp，单张 ≤10MB，最多 20 张
                </small>
              </div>
            )}
          </div>
        </section>

        <section
          aria-label="实时预览"
          className={cn("min-h-0 overflow-y-auto bg-bg", mobileTab === "edit" && "max-md:hidden")}
        >
          <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-border bg-bg px-6 py-2.5 text-meta text-faint">
            <Eye size={14} aria-hidden /> 实时预览 · 与发布后效果一致
          </div>
          <div className="px-5 pb-10 pt-3.5 sm:px-8">
            <BlogChips category={draft.category} minutes={blogReadMinutes(draft.bodyMarkdown)} approx />
            <h1 className="my-3 text-[24px] font-bold leading-[1.35] text-fg">{draft.title || "（未填写标题）"}</h1>
            {draft.summary && <p className="mb-4 text-[15px] leading-[1.7] text-muted">{draft.summary}</p>}
            {draft.bodyMarkdown.trim() ? (
              <div className="[&_.blog-prose_.prose]:text-[15px]">
                <BlogProse markdown={draft.bodyMarkdown} source={source} pending={pendingPercent} />
              </div>
            ) : (
              <p className="text-body text-faint">正文写好后会在这里实时预览。</p>
            )}
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-2.5 border-t border-border bg-surface px-3.5 py-2.5 sm:px-6 sm:py-3">
        <span className="flex w-full items-center gap-1.5 text-[12.5px] text-muted sm:w-auto">
          <ShieldCheck size={14} aria-hidden />
          {aiReview
            ? "提交后由 AI 自动审核，通常 1 分钟内出结果；拿不准的会转人工复核"
            : "提交后由管理员审核，通过后公开"}
        </span>
        {error && <Alert tone="danger" className="w-full sm:order-last">{error}</Alert>}
        <div className="hidden flex-1 sm:block" />
        <Button variant="ghost" shape="pill" className="text-muted max-sm:flex-1" onClick={saveLocal}>
          存为草稿
        </Button>
        <Button
          variant="accent"
          shape="pill"
          className="shadow-[0_4px_14px_#5a3fee38] max-sm:flex-1"
          loading={submitting}
          aria-disabled={!!issue}
          title={issue ?? undefined}
          onClick={() => void submit()}
        >
          <Send size={15} /> {editing ? "提交修改" : "提交发布"}
        </Button>
      </div>
    </div>
  );
}
