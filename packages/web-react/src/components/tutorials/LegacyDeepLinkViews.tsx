import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { capabilityById } from "../../lib/productCapabilities";
import { TASKBOARD_ENABLED } from "../../lib/taskboardFeature";
import {
  TUTORIAL_CASE_BY_ID,
  type TutorialCase,
  type TutorialCaseCategory,
  type TutorialCaseId,
} from "../../lib/tutorialCaseCatalog";
import { TUTORIAL_PENDING_CAPTURE_LABEL } from "../../lib/tutorialJourneys";
import { showcaseById } from "../../lib/tutorialShowcase";
import type { SignatureWork } from "../../lib/tutorialSignatureWorks";
import type { AuthSession } from "../../lib/types";
import { Button } from "../ui";
import { CASE_PRESENTATION } from "./CaseArtwork";
import { ShowcaseDetail } from "./CaseShowroom";
import { CommunityTutorials } from "./CommunityTutorials";
import { SignatureDetail } from "./SignatureShowcases";
import { TutorialReplay } from "./TutorialReplay";

export type LegacyDeepLinkProps =
  | {
      kind: "work";
      work: SignatureWork;
      onBack: () => void;
      onRunCase?: (item: TutorialCase) => void;
      caseActionLabel?: string;
    }
  | {
      kind: "case";
      caseId: TutorialCaseId;
      onBack: () => void;
      onRunCase?: (item: TutorialCase) => void;
      caseActionLabel?: string;
    }
  | {
      kind: "community";
      communityId: string;
      auth?: AuthSession | null;
      onRequireLogin?: () => void;
      activeSessionId?: string | null;
      sessionMessages?: ChatMessage[];
      sending?: boolean;
      sessionTitle?: string;
      sessionProjectId?: string | null;
      onCommunityChange?: (id: string | null) => void;
    };

/**
 * 历史深链静默兜底视图：兼容 `?work=` / `?case=` / `?community=` 外部链接与旧测试契约，
 * 不在主导航中露面。用户点返回或切换顶栏页签即可无缝回到新版三页签。
 */
export function LegacyDeepLinkViews(props: LegacyDeepLinkProps) {
  if (props.kind === "work") {
    return (
      <SignatureDetail
        key={props.work.id}
        work={props.work}
        onBack={props.onBack}
        onRun={props.onRunCase}
        actionLabel={props.caseActionLabel}
      />
    );
  }

  if (props.kind === "community") {
    return (
      <CommunityTutorials
        auth={props.auth}
        onRequireLogin={props.onRequireLogin}
        activeSessionId={props.activeSessionId}
        sessionMessages={props.sessionMessages}
        sending={props.sending}
        sessionTitle={props.sessionTitle}
        sessionProjectId={props.sessionProjectId}
        initialDetailId={props.communityId}
        onDetailIdChange={props.onCommunityChange}
      />
    );
  }

  const selectedShowcase = showcaseById(props.caseId);
  if (selectedShowcase) {
    return (
      <ShowcaseDetail
        key={selectedShowcase.caseId}
        item={selectedShowcase}
        onBack={props.onBack}
        onRun={props.onRunCase}
        actionLabel={props.caseActionLabel}
      />
    );
  }

  const selectedCase = TUTORIAL_CASE_BY_ID[props.caseId] ?? null;
  if (!selectedCase) return null;

  return (
    <LegacyCaseDetail
      item={selectedCase}
      onBack={props.onBack}
      onRun={props.onRunCase}
      actionLabel={props.caseActionLabel}
    />
  );
}

function LegacyCaseDetail({
  item,
  onBack,
  onRun,
  actionLabel,
}: {
  item: TutorialCase;
  onBack: () => void;
  onRun?: (item: TutorialCase) => void;
  actionLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyPrompt = () => {
    void navigator.clipboard
      ?.writeText(item.starterPrompt)
      .then(() => {
        setCopied(true);
        if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  const presentation = CASE_PRESENTATION[item.id];
  const storyLabel = caseCategoryStoryLabel(item.category);

  return (
    <article
      className="mx-auto max-w-4xl px-4 pb-14 pt-4 sm:px-7 sm:pt-6"
      data-case-id={item.id}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="-ml-2 min-h-11 text-muted hover:text-fg sm:min-h-8"
      >
        <ArrowLeft size={14} /> 返回帮助与经验
      </Button>

      {item.replay.status === "pending_capture" && (
        <p className="oc-callout oc-callout-warning mt-3 rounded-xl px-4 py-2.5 text-meta font-medium text-warning">
          {TUTORIAL_PENDING_CAPTURE_LABEL}。下面是人工编写的任务脚本与观察记录，不是平台验证过的运行回放。
        </p>
      )}

      <section className="oc-surface-card mt-4 rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="oc-badge-craft rounded-full bg-accent-soft px-2.5 py-1 text-micro font-semibold text-accent">
            {storyLabel} · 任务参考
          </span>
          <span className="oc-badge-craft rounded-full bg-hover px-2.5 py-1 text-micro text-muted">
            {item.difficulty}
          </span>
        </div>
        <p className="mt-3 text-caption font-semibold leading-5 text-accent">
          {presentation.pain}
        </p>
        <h1 className="mt-1 text-balance text-title font-bold leading-tight tracking-tight text-fg sm:text-2xl">
          {item.title}
        </h1>
        <p className="mt-2.5 text-body leading-6 text-muted">{item.summary}</p>

        <div className="oc-callout oc-callout-info mt-4 rounded-xl p-3.5">
          <p className="text-micro font-semibold uppercase tracking-widest text-accent">
            预期产出
          </p>
          <p className="mt-1 text-meta font-semibold leading-5 text-fg">
            {presentation.result}
          </p>
        </div>

        {onRun && (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={() => onRun(item)}
              aria-label={
                actionLabel
                  ? `带着我的材料开始，${actionLabel}`
                  : "带着我的材料开始"
              }
              className="min-h-11 w-full justify-center sm:min-h-9 sm:w-auto"
            >
              带着我的材料开始 <ArrowRight size={15} />
            </Button>
            <Button
              variant="secondary"
              onClick={copyPrompt}
              className="min-h-11 w-full justify-center sm:min-h-9 sm:w-auto"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制指令" : "复制开工指令"}
            </Button>
            <p className="w-full text-caption leading-4 text-faint">
              {actionLabel === "登录后试用"
                ? "登录后会自动带入这套任务方法"
                : "会新建对话，并带入可修改的开工指令"}
            </p>
          </div>
        )}
      </section>

      <section className="mt-8" aria-labelledby="legacy-case-stages-title">
        <h2
          id="legacy-case-stages-title"
          className="text-section font-semibold tracking-tight text-fg"
        >
          推进阶段
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {item.stages.map((stage, index) => (
            <article
              key={stage.id}
              className="oc-surface-card rounded-xl p-4"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-semibold tabular-nums text-accent-fg">
                  {index + 1}
                </span>
                <h3 className="text-body font-semibold text-fg">
                  {stage.title}
                </h3>
              </div>
              <p className="oc-surface-recessed mt-3 rounded-lg p-3 text-caption leading-5 text-fg">
                {stage.output}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <div className="oc-code-shell">
          <div className="oc-code-shell-header flex items-center justify-between gap-3 px-4 py-2.5">
            <h2 className="text-meta font-semibold text-fg">完整开工指令</h2>
            <Button variant="ghost" size="sm" onClick={copyPrompt}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制" : "复制指令"}
            </Button>
          </div>
          <blockquote className="max-h-72 overflow-y-auto whitespace-pre-wrap p-4 text-meta leading-6 text-muted">
            {item.starterPrompt}
          </blockquote>
        </div>
      </section>

      <details className="oc-surface-card group mt-8 overflow-hidden rounded-xl">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 outline-none transition-colors hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
          <div>
            <p className="text-body font-semibold text-fg">案例资料与验收说明</p>
            <p className="mt-0.5 text-caption text-faint">
              准备材料、验收方法、推荐能力与运行回放
            </p>
          </div>
          <ChevronDown
            size={16}
            className="shrink-0 text-faint transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-6 border-t border-border/70 px-4 py-5 sm:px-5">
          <section>
            <h3 className="text-meta font-semibold text-fg">准备材料</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {item.inputMaterials.map((input) => (
                <article key={input.title} className="rounded-xl bg-sidebar p-4">
                  <h4 className="text-meta font-semibold text-fg">{input.title}</h4>
                  <p className="mt-1 text-caption leading-5 text-muted">
                    {input.description}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-3">
                    {input.sourceUrl && (
                      <a
                        href={input.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
                      >
                        查看原始材料 <ExternalLink size={11} />
                      </a>
                    )}
                    {input.assetPath?.startsWith("/") && (
                      <a
                        href={input.assetPath}
                        download
                        className="inline-flex items-center gap-1 text-caption font-medium text-accent hover:underline"
                      >
                        下载案例副本 <Download size={11} />
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-meta font-semibold text-fg">怎么验收成果</h3>
              <ul className="mt-2.5 space-y-2">
                {item.checks.map((check) => (
                  <li
                    key={check.title}
                    className="oc-callout oc-callout-success rounded-xl p-3.5"
                  >
                    <p className="flex items-center gap-1.5 text-meta font-semibold text-fg">
                      <Check size={13} className="text-success" />
                      {check.title}
                    </p>
                    <p className="mt-1 text-caption leading-5 text-muted">
                      {check.passCriterion}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-meta font-semibold text-fg">涉及能力</h3>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {item.capabilityIds
                  .filter((id) => TASKBOARD_ENABLED || id !== "taskboard")
                  .map((id) => (
                  <span
                    key={id}
                    className="oc-badge-craft rounded-full bg-surface px-2.5 py-1 text-caption text-muted"
                  >
                    {capabilityById(id).shortTitle}
                  </span>
                ))}
              </div>
              {item.fieldReport && (
                <div className="oc-callout oc-callout-warning mt-4 rounded-xl p-3.5">
                  <h4 className="flex items-center gap-1.5 text-meta font-semibold text-fg">
                    <TriangleAlert size={13} className="text-warning" />
                    适用边界
                  </h4>
                  <ul className="mt-1.5 space-y-1">
                    {item.fieldReport.limitations.map((limitation) => (
                      <li key={limitation} className="text-caption leading-5 text-muted">
                        • {limitation}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-meta font-semibold text-fg">运行过程回放</h3>
            <TutorialReplay caseId={item.id} replay={item.replay} />
            {item.replay.status === "verified" && (
              <p className="mt-2 text-caption leading-5 text-faint">
                {item.replay.disclosure}
              </p>
            )}
          </section>
        </div>
      </details>
    </article>
  );
}

function caseCategoryStoryLabel(category: TutorialCaseCategory): string {
  if (category === "research") return "科研实战";
  if (category === "coding") return "编码实战";
  return "工作实战";
}
