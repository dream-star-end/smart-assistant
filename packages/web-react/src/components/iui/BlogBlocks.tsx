import { communityBlogBusinessActions, type CommunityBlogBusinessActions } from '../tool/context';
/**
 * 对话写博客（经验分享，OCV5-577 跟进）的三个智能 UI 组件。
 *
 * - BlogDraftBlock：Agent 写的草稿预览卡。修改点来自服务端预检（确定性检查，无 AI 预判）；「修复」把修改点
 *   以用户身份发给 Agent，由它出新版本；「确认投稿」在二次确认后由浏览器用用户登录态上传图片、调用
 *   `POST /api/tutorials`，之后走正常的 AI 审核。Agent 没有任何发布能力。
 * - BlogStatusBlock / BlogPublishedBlock：只带稿件 id，状态、理由、链接全部按 id 向服务端现查。
 */
import { ArrowUpRight, Circle, CircleAlert, CircleCheck, CircleX, Link2, LoaderCircle, PenLine, RefreshCw, ShieldCheck, SquarePen, TriangleAlert, UserCheck, Wand2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
// 不从 lib/tutorialStudio 取文案：它会把路由模块（连带任务面板）拉进智能 UI 的依赖里。
import { ApiError, apiErrorMessage } from "../../lib/api";
import type { CommunityTutorialMine } from "../../lib/types";
import { Markdown } from "../Markdown";
import { type CommunityBlogDraftPayload, chatInteractionUnavailableText, useChatInteraction, useToolCardActions } from "../tool/context";
import { BlogChips, BlogCover } from "../tutorials/blog/BlogArticle";
import { blogMineStage, blogReadMinutes, compressBlogImage } from "../tutorials/blog/blogLib";
import { Button, Modal } from "../ui";
import {
  type BlogIssue,
  type BlogPrecheck,
  composeFixMessage,
  composeRevisionMessage,
  composeSubmittedMessage,
  fixableIssues,
  issueWhere,
  latestDraftVersion,
  latestSubmitted,
  registerDraftVersion,
  rememberSubmitted,
  submittedFor,
  subscribeDraftVersions,
} from "./blogChat";
import { blogToMarkdown } from "./blogMarkdown";
import { type BlogDraftSpec, type BlogPublishedSpec, type BlogStatusSpec, bodyForPrecheck, draftImages, placeholderSha, replaceDraftImages } from "./blogSchema";
import { CopyButton, Frame, Media } from "./shell";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; readOnly?: boolean; nested?: boolean };

const CATEGORY_LABEL = { research: "研究", coding: "编程", general: "通用" } as const;

function payloadOf(spec: BlogDraftSpec, body: string): CommunityBlogDraftPayload {
  return { title: spec.title.trim(), summary: spec.summary.trim(), category: spec.category, bodyMarkdown: body.trim() };
}

/** 容器图片逐张读取、压缩、上传，换成 tutorial-blob 引用。onProgress(已完成, 总数)。 */
async function uploadDraftImages(actions: CommunityBlogBusinessActions, body: string, onProgress: (done: number, total: number) => void): Promise<string> {
  const images = draftImages(body);
  const shas = new Map<string, string>();
  onProgress(0, images.length);
  for (const image of images) {
    let blob: Blob;
    try {
      blob = await actions.readContainerImage(image.src);
    } catch {
      throw new Error(`读不到图片「${image.alt || image.src}」，可能已被删除`);
    }
    const compressed = await compressBlogImage(blob);
    const uploaded = await actions.uploadImage(compressed);
    shas.set(image.src, uploaded.sha256);
    onProgress(shas.size, images.length);
  }
  return replaceDraftImages(body, (src) => shas.get(src));
}

// ── 草稿卡 ────────────────────────────────────────────────────────────

type CheckState = { kind: "idle" } | { kind: "loading" } | { kind: "ready"; result: BlogPrecheck } | { kind: "error"; message: string };
type SubmitState = { kind: "idle" } | { kind: "working"; step: string } | { kind: "error"; message: string };

function useLatestVersion(draftId: string, version: number): number {
  // 渲染时就登记：历史里新旧版本一起挂载时，旧版本的预检 effect 跑之前已经知道自己过期。
  useState(() => registerDraftVersion(draftId, version, true));
  useEffect(() => registerDraftVersion(draftId, version), [draftId, version]);
  return useSyncExternalStore(subscribeDraftVersions, () => latestDraftVersion(draftId), () => version);
}

export function BlogDraftBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<BlogDraftSpec>) {
  const { communityBlog: navigation } = useToolCardActions();
  const actions = communityBlogBusinessActions(navigation);
  const { sendUserText, busy, reason } = useChatInteraction();
  const latest = useLatestVersion(spec.draftId, spec.version);
  const superseded = latest > spec.version;
  const [submitted, setSubmitted] = useState(() => submittedFor(spec.draftId, spec.version));
  // 更新的版本已经投过：这一版只读。更旧的投稿不挡这一版（被驳回后按理由改的新版本要能重投）。
  const [laterSubmitted] = useState(() => {
    const last = latestSubmitted(spec.draftId);
    return last && last.version > spec.version ? last : null;
  });
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [fixSent, setFixSent] = useState(false);
  const interactive = !!actions && !readOnly && !streaming && !superseded && !submitted && !laterSubmitted;

  const precheckBody = useMemo(() => bodyForPrecheck(spec.body), [spec.body]);
  const runCheck = useCallback(() => {
    if (!actions) return;
    setCheck({ kind: "loading" });
    actions
      .precheck(payloadOf(spec, precheckBody))
      .then((result) => setCheck({ kind: "ready", result }))
      .catch((error: unknown) => setCheck({ kind: "error", message: apiErrorMessage(error, "检查没有完成") }));
  }, [actions, spec, precheckBody]);
  // 只有当前可投稿的那一版自动预检；旧版本、已投稿、只读上下文不调用。
  useEffect(() => {
    if (interactive && latestDraftVersion(spec.draftId) <= spec.version) runCheck();
  }, [interactive, runCheck, spec.draftId, spec.version]);

  if (submitted) return <BlogStatusView id={submitted.id} nested={nested} readOnly={readOnly} />;

  const issues = check.kind === "ready" ? check.result.issues : [];
  const blocking = issues.filter((i) => i.level === "block");
  const images = draftImages(spec.body);
  const canAsk = !!sendUserText && !busy && interactive && !fixSent;
  const sendFix = (list: readonly BlogIssue[]) => {
    if (!canAsk || !sendUserText || list.length === 0) return;
    setFixSent(true);
    sendUserText(composeFixMessage(spec, list));
  };
  const working = submit.kind === "working";

  const doSubmit = async () => {
    if (!actions || working) return;
    setSubmit({ kind: "working", step: "准备中" });
    try {
      const body = await uploadDraftImages(actions, spec.body, (done, total) => {
        if (total > 0) setSubmit({ kind: "working", step: `上传图片 ${done}/${total}` });
      });
      setSubmit({ kind: "working", step: "提交中" });
      const { id } = await actions.submit(payloadOf(spec, body));
      const record = { draftId: spec.draftId, version: spec.version, id, at: Date.now() };
      rememberSubmitted(record);
      setConfirmOpen(false);
      setSubmit({ kind: "idle" });
      setSubmitted(record);
      sendUserText?.(composeSubmittedMessage(spec, id));
    } catch (error) {
      setSubmit({ kind: "error", message: apiErrorMessage(error, "投稿没有成功") });
    }
  };
  const doOpenEditor = async () => {
    if (!actions || working) return;
    setSubmit({ kind: "working", step: "准备编辑器" });
    try {
      const body = await uploadDraftImages(actions, spec.body, (done, total) => {
        if (total > 0) setSubmit({ kind: "working", step: `上传图片 ${done}/${total}` });
      });
      setSubmit({ kind: "idle" });
      actions.openEditor(payloadOf(spec, body));
    } catch (error) {
      setSubmit({ kind: "error", message: apiErrorMessage(error, "没能打开编辑器") });
    }
  };

  const status = laterSubmitted ? (
    <span className="oc-iui-chip">v{laterSubmitted.version} 已投稿</span>
  ) : superseded ? (
    <span className="oc-iui-chip">已有新版本</span>
  ) : (
    <span className="oc-iui-chip">未投稿</span>
  );
  const subtitle = `${CATEGORY_LABEL[spec.category]} · 约 ${blogReadMinutes(spec.body)} 分钟${images.length > 0 ? ` · ${images.length} 张图` : ""}`;
  return (
    <Frame kind="blog_draft" title={`经验分享草稿 · v${spec.version}`} subtitle={subtitle} notes={notes} streaming={streaming} nested={nested} actions={status}>
      {spec.note && <p className="oc-blog-chat-note">本版改动：{spec.note}</p>}
      <DraftPreview spec={spec} />
      {!actions && navigation && !readOnly && !streaming && <div className="oc-blog-chat-actions">
        {images.length === 0 && <Button variant="secondary" onClick={() => navigation.openEditor(payloadOf(spec, spec.body))}>在编辑器里改</Button>}
        <Button variant="ghost" onClick={navigation.openMine}>查看我的投稿</Button>
      </div>}
      {laterSubmitted ? (
        <p className="oc-blog-chat-hint">这份草稿的 v{laterSubmitted.version} 已经投稿（稿件 #{laterSubmitted.id}），这一版不能再投。</p>
      ) : superseded ? (
        <p className="oc-blog-chat-hint">下面有更新的版本（v{latest}），请在新版本上确认。</p>
      ) : !actions ? (
        <p className="oc-blog-chat-hint">{readOnly ? "这是一份经验分享草稿。" : "在网页对话里登录后可以一键投稿；也可以复制 Markdown，到「经验分享 → 写一篇经验」粘贴。"}</p>
      ) : (
        <>
          <Issues state={check} canAsk={canAsk} fixSent={fixSent} onFix={sendFix} onRetry={runCheck} />
          {submit.kind === "error" && <p className="oc-blog-chat-error" role="alert">{submit.message}</p>}
        </>
      )}
      <div className="oc-blog-chat-actions">
        {interactive && (
          <Button variant="accent" disabled={check.kind !== "ready" || blocking.length > 0 || working} onClick={() => setConfirmOpen(true)}>
            确认投稿
          </Button>
        )}
        {interactive && (
          <Button variant="secondary" disabled={working} loading={working && !confirmOpen} onClick={() => void doOpenEditor()}>
            <SquarePen size={15} aria-hidden />
            在编辑器里改
          </Button>
        )}
        <CopyButton getText={() => blogToMarkdown(spec)} label="复制 Markdown" />
        {interactive && check.kind === "ready" && blocking.length > 0 && <span className="oc-blog-chat-hint is-inline">先处理 {blocking.length} 个修改点</span>}
        {interactive && !sendUserText && reason && <span className="oc-blog-chat-hint is-inline">{chatInteractionUnavailableText(reason)}</span>}
      </div>
      {actions && (
        <Modal
          open={confirmOpen}
          onOpenChange={(open) => {
            if (!working) setConfirmOpen(open);
          }}
          title="确认投稿到经验分享？"
          size="sm"
          mobile="sheet"
          footer={
            <>
              <Button variant="secondary" disabled={working} onClick={() => setConfirmOpen(false)}>
                再看看
              </Button>
              <Button variant="accent" loading={working} onClick={() => void doSubmit()}>
                {working ? submit.step : "确认投稿"}
              </Button>
            </>
          }
        >
          <dl className="oc-blog-chat-confirm">
            <dt>标题</dt>
            <dd>{spec.title}</dd>
            <dt>分类</dt>
            <dd>{CATEGORY_LABEL[spec.category]}</dd>
            <dt>图片</dt>
            <dd>{images.length > 0 ? `${images.length} 张（投稿时自动压缩上传）` : "无"}</dd>
          </dl>
          <ul className="oc-blog-chat-confirm-notes">
            <li>投稿后由 AI 审核：明确没问题的自动公开，拿不准的转站长复核，未通过会告诉你理由。</li>
            <li>公开后所有人可见，不会被搜索引擎收录；随时可以在「我的投稿」修改（会重新审核）或撤回。</li>
          </ul>
          {submit.kind === "error" && <p className="oc-blog-chat-error" role="alert">{submit.message}</p>}
        </Modal>
      )}
    </Frame>
  );
}

function DraftPreview({ spec }: { spec: BlogDraftSpec }) {
  const [expanded, setExpanded] = useState(false);
  const images = useMemo(() => draftImages(spec.body), [spec.body]);
  // 预览：容器图片换成占位 sha，交给经验分享的图片渲染口，再按序号找回原路径走签名显示。
  const previewBody = useMemo(() => bodyForPrecheck(spec.body), [spec.body]);
  const renderImage = useCallback(
    (sha: string, image: { alt: string }) => {
      const hit = images.find((i) => placeholderSha(i.index) === sha);
      return hit ? (
        <span className="blog-figure">
          <Media src={hit.src} alt={image.alt || hit.alt || "图片"} className="oc-blog-chat-figure" />
          {image.alt && <span className="blog-figcaption">{image.alt}</span>}
        </span>
      ) : null;
    },
    [images],
  );
  return (
    <div className={expanded ? "oc-blog-chat-paper is-expanded" : "oc-blog-chat-paper"}>
      <BlogChips category={spec.category} minutes={blogReadMinutes(spec.body)} approx />
      <h3 className="oc-blog-chat-title">{spec.title}</h3>
      {spec.summary && <p className="oc-blog-chat-summary">{spec.summary}</p>}
      <div className="oc-blog-chat-body blog-prose">
        <Markdown readOnly tutorialImage={renderImage}>
          {previewBody}
        </Markdown>
      </div>
      <div className="oc-blog-chat-fold">
        <button type="button" className="oc-iui-text-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      </div>
    </div>
  );
}

function Issues({
  state,
  canAsk,
  fixSent,
  onFix,
  onRetry,
}: {
  state: CheckState;
  canAsk: boolean;
  fixSent: boolean;
  onFix: (issues: readonly BlogIssue[]) => void;
  onRetry: () => void;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <p className="oc-blog-chat-checking" aria-live="polite">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
        正在检查格式、隐私和图片…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="oc-blog-chat-checking is-error" role="alert">
        <CircleAlert size={14} aria-hidden />
        {state.message}
        <button type="button" className="oc-iui-text-btn" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden />
          重新检查
        </button>
      </div>
    );
  }
  const { issues } = state.result;
  if (issues.length === 0) {
    return (
      <div className="oc-blog-chat-pass">
        <ShieldCheck size={16} aria-hidden />
        <div>
          <div className="font-semibold">检查通过</div>
          <div className="oc-blog-chat-pass-sub">格式与长度、隐私和密钥扫描、图片、对审核者的指令。是否公开由投稿后的审核决定。</div>
        </div>
      </div>
    );
  }
  const fixable = fixableIssues(issues);
  return (
    <section className="oc-blog-chat-issues" aria-label="修改点">
      <header>
        <span className="oc-blog-chat-issues-title">
          <CircleAlert size={15} aria-hidden />
          {issues.length} 个修改点
        </span>
        {fixable.length > 1 && (
          <Button size="sm" variant="secondary" disabled={!canAsk} onClick={() => onFix(fixable)}>
            <Wand2 size={14} aria-hidden />
            全部修复（{fixable.length}）
          </Button>
        )}
      </header>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.field}:${issue.where ?? ""}`}>
            {issue.level === "block" ? (
              <CircleX size={15} className="oc-blog-chat-ico is-block" aria-label="必须修改" />
            ) : (
              <TriangleAlert size={15} className="oc-blog-chat-ico is-warn" aria-label="会转人工" />
            )}
            <div className="min-w-0 flex-1">
              <span className="oc-blog-chat-where">{issueWhere(issue)}</span>
              {issue.message}
            </div>
            {issue.field !== "quota" && (
              <Button size="sm" variant="ghost" className="oc-blog-chat-fix" disabled={!canAsk} aria-label={`修复：${issueWhere(issue)}，${issue.message}`} onClick={() => onFix([issue])}>
                修复
              </Button>
            )}
          </li>
        ))}
      </ul>
      {fixSent && <p className="oc-blog-chat-hint">已把修改点发给助手，新版本会出现在下面。</p>}
    </section>
  );
}

// ── 状态卡 / 链接卡：数据只来自服务端 ─────────────────────────────────

const POLL_FAST_MS = 5_000;
const POLL_SLOW_MS = 30_000;
const FAST_WINDOW_MS = 2 * 60_000;
const STOP_AFTER_MS = 30 * 60_000;

type LoadState = { kind: "loading" } | { kind: "ok"; item: CommunityTutorialMine } | { kind: "missing" } | { kind: "error"; message: string };

function useOwnTutorial(id: string, actions: CommunityBlogBusinessActions | undefined): { state: LoadState; stopped: boolean; refresh: () => void } {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [stopped, setStopped] = useState(false);
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 只用来手动重启轮询
  useEffect(() => {
    if (!actions) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, POLL_FAST_MS);
        return;
      }
      let settled = false;
      try {
        const item = await actions.getMine(id);
        if (!alive) return;
        setState({ kind: "ok", item });
        settled = !(item.status === "pending");
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ kind: "missing" });
          settled = true;
        } else setState((prev) => (prev.kind === "ok" ? prev : { kind: "error", message: apiErrorMessage(error, "读取审核状态失败") }));
      }
      const age = Date.now() - startedRef.current;
      if (settled) return;
      if (age > STOP_AFTER_MS) {
        setStopped(true);
        return;
      }
      timer = setTimeout(tick, age < FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [id, actions, nonce]);
  const refresh = useCallback(() => {
    startedRef.current = Date.now();
    setStopped(false);
    setNonce((n) => n + 1);
  }, []);
  return { state, stopped, refresh };
}

const STEPS = ["已提交", "安全扫描", "内容审核", "发布"] as const;

function ReviewSteps({ current }: { current: number }) {
  return (
    <ol className="oc-blog-chat-steps" aria-label="审核进度">
      {STEPS.map((label, index) => {
        const state = index < current ? "done" : index === current ? "cur" : "todo";
        const Icon = state === "done" ? CircleCheck : state === "cur" ? LoaderCircle : Circle;
        return (
          <Fragment key={label}>
            {index > 0 && <span aria-hidden className="oc-blog-chat-step-line" />}
            <li className={`is-${state}`} aria-current={state === "cur" ? "step" : undefined}>
              <Icon size={13} aria-hidden className={state === "cur" ? "animate-spin motion-reduce:animate-none" : undefined} />
              {label}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

const STAGE_CHIP = {
  ai: { label: "AI 审核中", className: "blog-chip-info", icon: LoaderCircle },
  human: { label: "人工复核中", className: "blog-chip-warn", icon: UserCheck },
  published: { label: "已发布", className: "blog-chip-ok", icon: CircleCheck },
  rejected: { label: "未通过", className: "blog-chip-bad", icon: CircleX },
  withdrawn: { label: "已撤回", className: "", icon: CircleX },
  takedown: { label: "已下架", className: "blog-chip-bad", icon: CircleX },
  draft: { label: "草稿", className: "", icon: Circle },
} as const;

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function BlogStatusView({ id, nested, readOnly }: { id: string; nested?: boolean; readOnly?: boolean }) {
  // 只读上下文（站内信、分享页）不查状态：稿件只对作者本人可见。
  const blogActions = useToolCardActions().communityBlog;
  const actions = readOnly ? undefined : communityBlogBusinessActions(blogActions);
  const { sendUserText, busy } = useChatInteraction();
  const { state, stopped, refresh } = useOwnTutorial(id, actions);
  const [asked, setAsked] = useState(false);
  if (!actions) {
    return (
      <Frame kind="blog_status" title={`经验分享稿件 #${id}`} subtitle="到「经验分享 → 我的投稿」查看审核状态" nested={nested} className="oc-blog-chat-card">
        <span />
      </Frame>
    );
  }
  if (state.kind !== "ok") {
    return (
      <Frame kind="blog_status" title={`经验分享稿件 #${id}`} nested={nested} className="oc-blog-chat-card">
        <div className="oc-blog-chat-pad" aria-live="polite">
          {state.kind === "loading" ? (
            <p className="oc-blog-chat-checking">
              <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
              正在读取审核状态…
            </p>
          ) : state.kind === "missing" ? (
            <p className="oc-blog-chat-hint">找不到这篇投稿，或者它不是你的投稿。</p>
          ) : (
            <p className="oc-blog-chat-error">
              {state.message}
              <button type="button" className="oc-iui-text-btn" onClick={refresh}>
                重试
              </button>
            </p>
          )}
        </div>
      </Frame>
    );
  }
  const item = state.item;
  const stage = blogMineStage(item);
  if (stage === "published") return <PublishedView item={item} nested={nested} />;
  const chip = STAGE_CHIP[stage];
  const ChipIcon = chip.icon;
  const askRevision = () => {
    if (!sendUserText || busy || asked) return;
    setAsked(true);
    sendUserText(composeRevisionMessage(item.id, item.reviewNote));
  };
  return (
    <Frame
      kind="blog_status"
      title={item.title}
      subtitle={`稿件 #${item.id} · 提交于 ${clock(item.createdAt)}`}
      nested={nested}
      className="oc-blog-chat-card"
      actions={
        <span className={`blog-chip ${chip.className}`}>
          <ChipIcon size={12} aria-hidden className={stage === "ai" ? "animate-spin motion-reduce:animate-none" : undefined} />
          {chip.label}
        </span>
      }
    >
      <div className="oc-blog-chat-pad" aria-live="polite">
        {stage === "ai" && (
          <>
            <ReviewSteps current={2} />
            <p className="oc-blog-chat-muted">一般 1 分钟内出结果。明确没问题会自动公开；AI 拿不准会转给站长复核，出结果后站内信通知你。这张卡会自动刷新。</p>
          </>
        )}
        {stage === "human" && <p className="oc-blog-chat-muted">AI 没能确定这篇是否合规，已转给站长复核，一般 24 小时内处理，结果会发站内信。</p>}
        {(stage === "rejected" || stage === "takedown") && (
          <div className="oc-blog-chat-reason">
            <div className="font-semibold">{stage === "rejected" ? "审核理由" : "下架理由"}</div>
            {item.reviewNote || "没有填写理由。"}
          </div>
        )}
        {stage === "withdrawn" && <p className="oc-blog-chat-muted">这篇投稿已撤回，不再公开。</p>}
        {stopped && (
          <button type="button" className="oc-iui-text-btn" onClick={refresh}>
            <RefreshCw size={13} aria-hidden />
            刷新状态
          </button>
        )}
        <div className="oc-blog-chat-actions is-flat">
          {stage === "rejected" && (
            <Button variant="accent" disabled={!sendUserText || busy || asked} onClick={askRevision}>
              <PenLine size={15} aria-hidden />
              {asked ? "已请助手修改" : "按理由修改"}
            </Button>
          )}
          {(stage === "rejected" || stage === "withdrawn") && (
            <Button
              variant="secondary"
              onClick={() =>
                actions.openEditor({ title: item.title, summary: item.summary, category: item.category, bodyMarkdown: item.bodyMarkdown })
              }
            >
              <SquarePen size={15} aria-hidden />
              在编辑器里改
            </Button>
          )}
          <Button variant="ghost" onClick={actions.openMine}>
            查看我的投稿
          </Button>
        </div>
      </div>
    </Frame>
  );
}

function PublishedView({ item, nested }: { item: CommunityTutorialMine; nested?: boolean }) {
  const { communityBlog: actions } = useToolCardActions();
  const [copied, setCopied] = useState(false);
  if (!actions) return null;
  const href = actions.postUrl(item.id);
  const copy = () => {
    void navigator.clipboard?.writeText(href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Frame
      kind="blog_published"
      title="已发布到经验分享"
      subtitle={`稿件 #${item.id}${item.publishedAt ? ` · ${clock(item.publishedAt)} 公开` : ""}`}
      nested={nested}
      className="oc-blog-chat-card"
      actions={
        <span className="blog-chip blog-chip-ok">
          <CircleCheck size={12} aria-hidden />
          已发布
        </span>
      }
    >
      <div className="oc-blog-chat-link">
        <BlogCover item={{ category: item.category, coverSha: item.coverSha ?? null }} className="oc-blog-chat-cover" />
        <div className="min-w-0 p-3.5">
          <BlogChips category={item.category} minutes={item.readMinutes ?? blogReadMinutes(item.bodyMarkdown)} />
          <div className="oc-blog-chat-link-title">{item.title}</div>
          <p className="oc-blog-chat-link-summary">{item.summary}</p>
          <div className="oc-blog-chat-url">{href}</div>
        </div>
      </div>
      <div className="oc-blog-chat-actions">
        <Button variant="accent" onClick={() => actions.openPost(item.id)}>
          <ArrowUpRight size={15} aria-hidden />
          打开文章
        </Button>
        <Button variant="secondary" onClick={copy}>
          <Link2 size={15} aria-hidden />
          {copied ? "已复制" : "复制链接"}
        </Button>
        <Button variant="ghost" onClick={actions.openMine}>
          查看我的投稿
        </Button>
      </div>
    </Frame>
  );
}


export function BlogStatusBlock({ spec, nested, readOnly }: BlockProps<BlogStatusSpec>) {
  return <BlogStatusView id={spec.id} nested={nested} readOnly={readOnly} />;
}

export function BlogPublishedBlock({ spec, nested, readOnly }: BlockProps<BlogPublishedSpec>) {
  return <BlogStatusView id={spec.id} nested={nested} readOnly={readOnly} />;
}
