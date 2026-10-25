import {
  ArrowLeft,
  Circle,
  CircleCheck,
  CircleX,
  LoaderCircle,
  SquarePen,
  UserCheck,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../../lib/api";
import type { AuthSession, CommunityTutorialMine } from "../../../lib/types";
import { cn } from "../../../lib/utils";
import { Alert, Button, ListSkeleton, useConfirm, useToast } from "../../ui";
import { BlogCover, type BlogImageSource } from "./BlogArticle";
import type { BlogEditTarget } from "./BlogEditor";
import {
  type BlogDraft,
  type BlogEditStage,
  type BlogMineStage,
  blogCanEdit,
  blogEditChangeMessage,
  blogEditSeed,
  blogEditStage,
  blogFirstImageSha,
  blogMineStage,
  blogShortDate,
  blogStageChangeMessage,
} from "./blogLib";

const POLL_MS = 10_000;

const STAGE_CHIP: Record<BlogMineStage, { label: string; className: string; icon: typeof Circle }> = {
  ai: { label: "AI 审核中", className: "blog-chip-info", icon: LoaderCircle },
  human: { label: "人工复核中", className: "blog-chip-warn", icon: UserCheck },
  published: { label: "已发布", className: "blog-chip-ok", icon: CircleCheck },
  rejected: { label: "未通过", className: "blog-chip-bad", icon: CircleX },
  withdrawn: { label: "已撤回", className: "", icon: CircleX },
  takedown: { label: "已下架", className: "blog-chip-bad", icon: CircleX },
  draft: { label: "草稿", className: "", icon: Circle },
};

/** 撤回确认里的后果说明(经验分享的口径)。 */
function withdrawConsequence(item: CommunityTutorialMine): string {
  if (item.status === "approved") {
    return item.edit?.status === "pending"
      ? "这篇会从经验分享下线，读者将无法再打开；正在审核的修改也会作废。撤回后不能再修改，可以复制为新稿重新投稿。"
      : "这篇会从经验分享下线，读者将无法再打开。撤回后不能再修改，可以复制为新稿重新投稿。";
  }
  return "这篇会退出审核。撤回后不能再修改，可以复制为新稿重新投稿。";
}

function submittedClock(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `提交于 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return blogShortDate(iso);
}

function ReviewSteps() {
  const steps: Array<{ label: string; state: "done" | "cur" | "todo" }> = [
    { label: "已提交", state: "done" },
    { label: "安全扫描", state: "done" },
    { label: "内容审核", state: "cur" },
    { label: "发布", state: "todo" },
  ];
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-[12px] text-faint" aria-label="审核进度">
      {steps.map((step, index) => {
        const Icon = step.state === "done" ? CircleCheck : step.state === "cur" ? LoaderCircle : Circle;
        return (
          <Fragment key={step.label}>
            {index > 0 && <span aria-hidden className="h-px w-2.5 bg-border-strong sm:w-[18px]" />}
            <li
              aria-current={step.state === "cur" ? "step" : undefined}
              className={cn(
                "flex items-center gap-1 whitespace-nowrap",
                step.state === "done" && "text-success",
                step.state === "cur" && "font-semibold text-accent",
              )}
            >
              <Icon size={13} aria-hidden className={step.state === "cur" ? "animate-spin motion-reduce:animate-none" : undefined} />
              {step.label}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** 已发布帖的修改状态:线上仍是原版,修改在审或没通过。 */
function EditNotice({ stage, item }: { stage: BlogEditStage; item: CommunityTutorialMine }) {
  if (stage === "rejected") {
    return (
      <div className="mt-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.6] text-fg">
        <b className="inline text-[13px]">修改未通过，线上仍是原版。原因：</b>
        {item.edit?.reviewNote ?? "未说明"}
      </div>
    );
  }
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-info-soft px-3 py-2.5 text-[13px] leading-[1.6] text-fg">
      <span className={cn("blog-chip", stage === "ai" ? "blog-chip-info" : "blog-chip-warn")}>
        {stage === "ai" ? (
          <LoaderCircle size={12} aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : (
          <UserCheck size={12} aria-hidden />
        )}
        {stage === "ai" ? "修改审核中" : "修改待人工复核"}
      </span>
      <span>线上仍是原版，新版本审核通过后自动替换。</span>
    </div>
  );
}

export function BlogMine({
  auth,
  onBack,
  onWrite,
  onEdit,
  onOpen,
}: {
  auth: AuthSession;
  onBack: () => void;
  onWrite: (seed?: BlogDraft) => void;
  /** 修改已投稿的帖子(待审 / 未通过 / 已发布)。 */
  onEdit: (seed: BlogDraft, target: BlogEditTarget) => void;
  onOpen: (id: string) => void;
}) {
  const toast = useToast();
  const [confirm, confirmElement] = useConfirm();
  const [items, setItems] = useState<CommunityTutorialMine[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const stagesRef = useRef(new Map<string, BlogMineStage>());
  const editStagesRef = useRef(new Map<string, BlogEditStage | null>());
  const privateSource = useMemo<BlogImageSource>(() => ({ kind: "private", auth }), [auth]);

  const load = useCallback(
    async (cursor: string | null, quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const page = await api.listMyCommunityTutorials(auth, cursor);
        const mine = page.tutorials.filter((item) => item.kind !== "snapshot");
        // 轮询时状态有变化就提示(审核出结果)。
        for (const item of mine) {
          const before = stagesRef.current.get(item.id);
          const after = blogMineStage(item);
          const message = before ? blogStageChangeMessage(item.title, before, after) : null;
          if (message) toast(message, after === "rejected" ? "info" : "success");
          stagesRef.current.set(item.id, after);
          const editAfter = blogEditStage(item);
          const editMessage = editStagesRef.current.has(item.id)
            ? blogEditChangeMessage(item.title, editStagesRef.current.get(item.id) ?? null, editAfter)
            : null;
          if (editMessage) toast(editMessage, editAfter === "rejected" ? "info" : "success");
          editStagesRef.current.set(item.id, editAfter);
        }
        setItems((current) => (cursor ? [...current, ...mine] : mine));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (cause) {
        if (!quiet) setError(apiErrorMessage(cause, "加载我的投稿失败"));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [auth, toast],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const hasPending = items.some((item) => item.status === "pending" || item.edit?.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => void load(null, true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasPending, load]);

  const withdraw = async (item: CommunityTutorialMine) => {
    const ok = await confirm({
      title: "撤回这篇投稿？",
      body: <p className="text-body text-muted">{withdrawConsequence(item)}</p>,
      confirmText: "撤回",
      danger: true,
    });
    if (ok !== true) return;
    setBusyId(item.id);
    try {
      await api.withdrawCommunityTutorial(auth, item.id);
      toast("已撤回", "success");
      await load(null);
    } catch (cause) {
      setError(apiErrorMessage(cause, "撤回失败"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[860px] px-4 pb-12 pt-5 sm:px-6 sm:pt-7">
      {confirmElement}
      <button
        type="button"
        onClick={onBack}
        className="mb-[22px] inline-flex items-center gap-1.5 rounded-md text-[13px] text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
      >
        <ArrowLeft size={15} /> 经验分享
      </button>
      <div className="mb-4 flex flex-col items-stretch gap-3.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="mb-1 text-[26px] font-bold text-fg">我的投稿</h1>
          <p className="m-0 text-[14px] text-muted">审核结果也会发到站内信。</p>
        </div>
        <Button variant="accent" shape="pill" className="shadow-[0_4px_14px_#5a3fee38]" onClick={() => onWrite()}>
          <SquarePen size={15} /> 写一篇经验
        </Button>
      </div>
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {loading && items.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-border p-10 text-center text-body text-faint">
          你还没有投稿。
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const stage = blogMineStage(item);
            const editStage = blogEditStage(item);
            const editable = blogCanEdit(item);
            const chip = STAGE_CHIP[stage];
            const Icon = chip.icon;
            const cover = { category: item.category, coverSha: item.coverSha ?? blogFirstImageSha(item.bodyMarkdown) };
            return (
              <article
                key={item.id}
                className="flex flex-wrap items-center gap-3.5 rounded-[20px] border border-border bg-surface p-3.5 sm:flex-nowrap sm:gap-4 sm:p-[16px_18px]"
              >
                <BlogCover
                  item={cover}
                  source={stage === "published" ? undefined : privateSource}
                  showChip={false}
                  className="!aspect-auto h-[120px] w-full shrink-0 rounded-xl sm:h-[72px] sm:w-[120px] [&_svg]:size-6"
                />
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <b className="mb-1.5 block text-[15px] text-fg">{item.title}</b>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={cn("blog-chip", chip.className)}>
                      <Icon size={12} aria-hidden className={stage === "ai" ? "animate-spin motion-reduce:animate-none" : undefined} />
                      {chip.label}
                    </span>
                    <span className="text-meta text-faint">
                      {stage === "published" && item.publishedAt
                        ? `${blogShortDate(item.publishedAt)} · 已被阅读 ${item.viewCount ?? 0} 次`
                        : stage === "ai"
                          ? submittedClock(item.createdAt)
                          : blogShortDate(item.reviewedAt ?? item.createdAt)}
                    </span>
                  </div>
                  {stage === "ai" && <ReviewSteps />}
                  {stage === "rejected" && item.reviewNote && (
                    <div className="mt-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.6] text-fg">
                      <b className="inline text-[13px]">原因：</b>
                      {item.reviewNote}
                    </div>
                  )}
                  {stage === "takedown" && item.reviewNote && (
                    <div className="mt-2.5 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] leading-[1.6] text-fg">
                      <b className="inline text-[13px]">下架原因：</b>
                      {item.reviewNote}
                    </div>
                  )}
                  {stage === "human" && (
                    <div className="mt-2.5 rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] leading-[1.6] text-fg">
                      AI 没能确定这篇是否合规，已转给管理员复核，一般 24 小时内处理。
                    </div>
                  )}
                  {editStage && <EditNotice stage={editStage} item={item} />}
                </div>
                <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
                  {stage === "published" && (
                    <Button variant="secondary" size="sm" shape="pill" onClick={() => onOpen(item.id)}>
                      查看
                    </Button>
                  )}
                  {editable && (
                    <Button
                      variant={stage === "rejected" || editStage === "rejected" ? "accent" : "secondary"}
                      size="sm"
                      shape="pill"
                      disabled={busyId !== null}
                      onClick={() => onEdit(blogEditSeed(item), { id: item.id, published: item.status === "approved" })}
                    >
                      <SquarePen size={14} aria-hidden /> {editStage === "rejected" ? "再改" : "修改"}
                    </Button>
                  )}
                  {(stage === "withdrawn" || stage === "takedown") && (
                    <Button
                      variant="secondary"
                      size="sm"
                      shape="pill"
                      onClick={() =>
                        onWrite({
                          title: item.title,
                          summary: item.summary,
                          category: item.category,
                          bodyMarkdown: item.bodyMarkdown,
                        })
                      }
                    >
                      复制为新稿
                    </Button>
                  )}
                  {(stage === "ai" || stage === "human" || stage === "published") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="pill"
                      className="text-muted"
                      loading={busyId === item.id}
                      disabled={busyId !== null}
                      onClick={() => void withdraw(item)}
                    >
                      撤回
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {nextCursor && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" shape="pill" loading={loading} onClick={() => void load(nextCursor)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
