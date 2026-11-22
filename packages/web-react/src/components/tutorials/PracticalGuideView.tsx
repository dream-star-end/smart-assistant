import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  RotateCcw,
  Search,
} from "lucide-react";
import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  capabilityById,
  type ProductFeatureId,
} from "../../lib/productCapabilities";
import { TASKBOARD_ENABLED } from "../../lib/taskboardFeature";
import { cn } from "../../lib/utils";
import { AtelierIcon } from "../ui/AtelierIcons";
import { Badge, Button } from "../ui";
import {
  GUIDE_BASICS_STORAGE_KEY,
  PRACTICAL_GUIDE_BASICS,
  PRACTICAL_GUIDE_CATEGORIES,
  PRACTICAL_GUIDE_SCENARIOS,
  type PracticalGuideCategory,
  type PracticalGuideScenario,
  visibleScenarioRelatedTopics,
} from "./practicalGuideData";

export interface PracticalGuideScenarioInput {
  id: string;
  title: string;
  prompt: string;
}

export interface PracticalGuideViewProps {
  authenticated?: boolean;
  actionLabel?: string;
  taskboardEnabled?: boolean;
  onTryScenario: (scenario: PracticalGuideScenarioInput) => void;
  onOpenTopic?: (topicId: ProductFeatureId) => void;
  onOpenQuickLookup?: () => void;
}

function readBasicsCollapsed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_BASICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeBasicsCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(GUIDE_BASICS_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // 隐私模式或受限环境忽略存储失败
  }
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级忽略，保持安静
  }
  return false;
}

export function PracticalGuideView({
  authenticated,
  actionLabel,
  taskboardEnabled = TASKBOARD_ENABLED,
  onTryScenario,
  onOpenTopic,
  onOpenQuickLookup,
}: PracticalGuideViewProps): JSX.Element {
  const [basicsCollapsed, setBasicsCollapsed] = useState<boolean>(() => readBasicsCollapsed());
  const [category, setCategory] = useState<PracticalGuideCategory>("all");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [draftPrompts, setDraftPrompts] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const primaryCtaLabel =
    actionLabel ?? (authenticated === false ? "登录后带入对话" : "带入对话直接试");

  const visibleScenarios = useMemo(() => {
    if (category === "all") return PRACTICAL_GUIDE_SCENARIOS;
    return PRACTICAL_GUIDE_SCENARIOS.filter((item) => item.category === category);
  }, [category]);

  const handleToggleBasics = () => {
    setBasicsCollapsed((prev) => {
      const next = !prev;
      writeBasicsCollapsed(next);
      return next;
    });
  };

  const handleToggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handlePromptChange = (id: string, value: string) => {
    setDraftPrompts((prev) => ({ ...prev, [id]: value }));
  };

  const handlePromptReset = (id: string) => {
    setDraftPrompts((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleCopyPrompt = async (id: string, prompt: string) => {
    const ok = await copyTextSafe(prompt);
    if (!ok) return;
    setCopiedId(id);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
      copyTimerRef.current = null;
    }, 1800);
  };

  const handleTry = (scenario: PracticalGuideScenario) => {
    const currentPrompt = (draftPrompts[scenario.id] ?? scenario.prompt).trim() || scenario.prompt;
    onTryScenario({
      id: scenario.id,
      title: scenario.title,
      prompt: currentPrompt,
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
      {/* 顶部轻量可折叠导览条：无进度环、无打卡焦虑 */}
      <section
        aria-label="4 件事，马上用顺手"
        className="oc-surface-card rounded-2xl p-4 sm:p-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-title font-semibold text-fg">4 件事，马上用顺手</h2>
            <p className="mt-0.5 text-meta text-muted">
              熟悉这四个顺手动作，大多数任务一轮就能直出可用成果。
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleBasics}
            aria-expanded={!basicsCollapsed}
            aria-controls="practical-guide-basics-grid"
            className="oc-btn-tactile inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border-control bg-surface px-3 text-meta font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          >
            <span>{basicsCollapsed ? "展开" : "收起"}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className={cn(
                "transition-transform duration-200",
                !basicsCollapsed && "rotate-180",
              )}
            />
          </button>
        </div>

        {!basicsCollapsed && (
          <div
            id="practical-guide-basics-grid"
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {PRACTICAL_GUIDE_BASICS.map((item, idx) => (
              <div
                key={item.id}
                className="oc-surface-recessed flex min-w-0 flex-col gap-2 rounded-xl p-3.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="oc-icon-badge oc-icon-badge-accent size-8 rounded-lg">
                    <AtelierIcon name={item.icon} size={16} />
                  </span>
                  <span className="font-mono text-caption tabular-nums text-faint">
                    0{idx + 1}
                  </span>
                </div>
                <h3 className="text-body font-semibold text-fg">{item.title}</h3>
                <p className="text-meta leading-relaxed text-muted">{item.description}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 场景筛选栏与说明 */}
      <section aria-label="高频实战场景" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-title font-semibold text-fg">按真实任务直接开工</h2>
            <p className="mt-0.5 text-meta text-muted">
              挑一个贴近手头工作的场景，点按钮带入输入框即可修改发送，不会自动替你发出。
            </p>
          </div>
          <div
            role="group"
            aria-label="场景分类筛选"
            className="flex flex-wrap items-center gap-1.5"
          >
            {PRACTICAL_GUIDE_CATEGORIES.map((option) => {
              const active = category === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCategory(option.id)}
                  className={cn(
                    "oc-btn-tactile inline-flex min-h-11 items-center justify-center rounded-full px-3.5 text-meta font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                    active
                      ? "bg-accent text-accent-fg shadow-soft"
                      : "border border-border bg-surface text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 8 张高频真实场景卡 */}
        <div className="grid gap-4 md:grid-cols-2">
          {visibleScenarios.map((scenario) => {
            const expanded = Boolean(expandedIds[scenario.id]);
            const currentPrompt = draftPrompts[scenario.id] ?? scenario.prompt;
            const isModified =
              draftPrompts[scenario.id] !== undefined &&
              draftPrompts[scenario.id] !== scenario.prompt;
            const isCopied = copiedId === scenario.id;
            const visibleRelatedTopics = visibleScenarioRelatedTopics(
              scenario.relatedTopics,
              taskboardEnabled,
            );

            return (
              <article
                key={scenario.id}
                data-scenario-id={scenario.id}
                className="oc-surface-card oc-surface-card-hover flex min-w-0 flex-col justify-between gap-4 rounded-2xl p-4 sm:p-5"
              >
                <div className="flex min-w-0 flex-col gap-2.5">
                  {/* 要素 1：分类 + 能力微标 */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="accent" size="sm">
                      {scenario.categoryLabel}
                    </Badge>
                    {scenario.capabilities.map((cap) => (
                      <Badge key={cap} tone="neutral" size="sm">
                        {cap}
                      </Badge>
                    ))}
                  </div>

                  {/* 要素 2：标题 */}
                  <h3 className="text-section font-semibold text-fg">{scenario.title}</h3>

                  {/* 要素 3：一句话拿到什么产出 */}
                  <p className="text-meta leading-relaxed text-muted">
                    {scenario.deliverable}
                  </p>
                </div>

                {/* 要素 4：主次动作 */}
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="accent"
                      size="sm"
                      shape="pill"
                      onClick={() => handleTry(scenario)}
                      className="min-h-11 sm:min-h-8"
                    >
                      {primaryCtaLabel}
                      <ArrowRight size={14} aria-hidden />
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      shape="pill"
                      aria-expanded={expanded}
                      aria-controls={`scenario-detail-${scenario.id}`}
                      onClick={() => handleToggleExpand(scenario.id)}
                      className="min-h-11 sm:min-h-8"
                    >
                      <span>看指令与要点</span>
                      <ChevronDown
                        size={14}
                        aria-hidden
                        className={cn(
                          "transition-transform duration-200",
                          expanded && "rotate-180",
                        )}
                      />
                    </Button>
                  </div>

                  {expanded && (
                    <div
                      id={`scenario-detail-${scenario.id}`}
                      className="oc-surface-recessed flex min-w-0 flex-col gap-3.5 rounded-xl p-3.5"
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label
                            htmlFor={`scenario-prompt-${scenario.id}`}
                            className="text-caption font-semibold text-fg"
                          >
                            开工指令（可直接修改后带入）
                          </label>
                          <div className="flex items-center gap-1.5">
                            {isModified && (
                              <button
                                type="button"
                                onClick={() => handlePromptReset(scenario.id)}
                                className="oc-btn-tactile inline-flex min-h-11 items-center gap-1 rounded-full px-2.5 text-caption font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
                              >
                                <RotateCcw size={12} aria-hidden />
                                恢复默认
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleCopyPrompt(scenario.id, currentPrompt)}
                              className="oc-btn-tactile inline-flex min-h-11 items-center gap-1 rounded-full border border-border-control bg-surface px-2.5 text-caption font-medium text-fg outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
                            >
                              {isCopied ? (
                                <Check size={12} aria-hidden className="text-success" />
                              ) : (
                                <Copy size={12} aria-hidden />
                              )}
                              <span>{isCopied ? "已复制" : "复制指令"}</span>
                            </button>
                          </div>
                        </div>
                        <textarea
                          id={`scenario-prompt-${scenario.id}`}
                          rows={4}
                          value={currentPrompt}
                          onChange={(event) =>
                            handlePromptChange(scenario.id, event.target.value)
                          }
                          className="w-full resize-y rounded-lg border border-border-control bg-surface px-3 py-2 text-base leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-body"
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <div className="text-caption font-semibold text-fg">实用要点</div>
                        <ul className="flex list-disc flex-col gap-1 pl-4 text-meta leading-relaxed text-muted">
                          {scenario.tips.map((tip) => (
                            <li key={tip}>{tip}</li>
                          ))}
                        </ul>
                      </div>

                      {onOpenTopic && visibleRelatedTopics.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2.5">
                          <span className="text-caption text-faint">相关能力：</span>
                          {visibleRelatedTopics.map((topicId) => {
                            const cap = capabilityById(topicId);
                            return (
                              <button
                                key={topicId}
                                type="button"
                                onClick={() => onOpenTopic(topicId)}
                                className="oc-btn-tactile inline-flex min-h-11 items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-caption font-medium text-muted outline-none hover:border-border-control hover:text-fg focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7"
                              >
                                <span>{cap.shortTitle}</span>
                                <ArrowRight size={11} aria-hidden />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* 底部轻入口：去功能速查 */}
      {onOpenQuickLookup && (
        <div className="oc-surface-recessed flex flex-col items-start justify-between gap-3 rounded-2xl px-4 py-3.5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5 text-meta text-muted">
            <Search size={15} aria-hidden className="shrink-0 text-accent" />
            <span>想查斜杠命令、快捷键，或某个具体功能的操作步骤？</span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            shape="pill"
            onClick={onOpenQuickLookup}
            className="min-h-11 shrink-0 sm:min-h-8"
          >
            打开功能速查
            <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
