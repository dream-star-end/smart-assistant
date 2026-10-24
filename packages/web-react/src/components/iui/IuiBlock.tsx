import { LegacyCardPolicyProvider } from './LegacyCardPolicy';
/**
 * Intelligent UI(OCV5-361)—— ```ui 块入口:解析 → 校验 → 分派到原生组件。
 *
 * 不让消息崩溃的三道兜底:
 *   1. 解析/校验失败 → 原文代码块 + 一行说明(或能转的转成 Markdown);
 *   2. 流式半截 → 先渲染已确定部分,否则显示与最终外形接近的骨架;
 *   3. 组件渲染异常 → 组件级错误边界,显示该组件的 Markdown 版本。
 */
import { parseSystemActionReference } from "@openclaude/protocol/browser";
import { SystemActionBlock } from "./SystemActionBlock";
import { Component, type ReactNode, useMemo } from "react";
import { isNextBlockCode } from "../../lib/nextBlock";
import { CalculatorBlock } from "./CalculatorBlock";
import { ChartBlock } from "./ChartBlock";
import { KvBlock, ProgressBlock, RouteBlock } from "./InfoBlocks";
import { FormBlock, QuizBlock, RecipeBlock } from "./InteractiveBlocks";
import { IntradayBlock, KlineBlock, QuoteBlock, StockListBlock } from "./MarketBlocks";
import { CardsBlock, GalleryBlock, SwatchesBlock, TilesBlock } from "./MediaBlocks";
import { BlogDraftBlock, BlogPublishedBlock, BlogStatusBlock } from "./BlogBlocks";
import { BiliCommentsBlock, BiliDanmakuBlock, BiliRankBlock, BiliSubtitleBlock, BiliVideoBlock, BiliVideosBlock } from "./BiliBlocks";
import { FeishuDocBlock, FeishuEventsBlock, WeiboHotBlock, WeiboPostsBlock, ZhihuAnswersBlock, ZhihuHotBlock } from "./PluginBlocks";
import { TableBlock } from "./TableBlock";
import { DraftBlock, OutlineBlock, SourcesBlock } from "./TextBlocks";
import {
  CalloutBlock,
  ChoiceBlock,
  CompareBlock,
  StatsBlock,
  StepsBlock,
  SuggestionsBlock,
  TabsBlock,
  TimelineBlock,
} from "./blocks";
import { parseUiBlock } from "./parse";
import { type IuiSpec, resolveType, validateSpec } from "./schema";
import { BodyMarkdown, Skeleton } from "./shell";
import { specToMarkdown } from "./toMarkdown";

/** 这些组件要等内容完整才渲染(交互依赖完整数据);流式期间显示骨架。 */
const WAIT_FOR_COMPLETE = new Set(["calculator", "choice", "suggestions", "callout", "quiz", "form", "recipe", "kline", "intraday", "blog_draft", "blog_status", "blog_published"]);

export class BlockBoundary extends Component<{ fallback: ReactNode; children: ReactNode; resetKey: string }, { failed: boolean; key: string }> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { failed: boolean; key: string }) {
    // 内容变了(流式增长 / 重新生成)就给组件一次重新渲染的机会。
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function RawFallback({ code, message }: { code: string; message: string }) {
  return (
    <div className="oc-iui oc-iui-bare" data-iui="fallback">
      <p className="oc-iui-hint">{message}</p>
      <pre className="overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-meta text-fg">{code}</pre>
    </div>
  );
}

/** spec → 组件。`nested` = 画在分段标签里(不再套卡片外框)。 */
export function renderSpec(spec: IuiSpec, notes: string[], streaming: boolean, readOnly?: boolean, nested?: boolean): ReactNode {
  const p = { notes, streaming, nested };
  switch (spec.type) {
    case "table":
      return <TableBlock spec={spec} {...p} />;
    case "chart":
      return <ChartBlock spec={spec} {...p} />;
    case "calculator":
      return <CalculatorBlock spec={spec} {...p} />;
    case "stats":
      return <StatsBlock spec={spec} {...p} />;
    case "steps":
      return <StepsBlock spec={spec} {...p} />;
    case "compare":
      return <CompareBlock spec={spec} {...p} />;
    case "callout":
      return <CalloutBlock spec={spec} {...p} />;
    case "tabs":
      return <TabsBlock spec={spec} {...p} renderNested={(b) => renderSpec(b, [], streaming, readOnly, true)} />;
    case "timeline":
      return <TimelineBlock spec={spec} {...p} />;
    case "suggestions":
      return <SuggestionsBlock spec={spec} {...p} readOnly={readOnly} />;
    case "choice":
      return <ChoiceBlock spec={spec} {...p} readOnly={readOnly} />;
    case "cards":
      return <CardsBlock spec={spec} {...p} />;
    case "gallery":
      return <GalleryBlock spec={spec} {...p} />;
    case "swatches":
      return <SwatchesBlock spec={spec} {...p} />;
    case "tiles":
      return <TilesBlock spec={spec} {...p} />;
    case "recipe":
      return <RecipeBlock spec={spec} {...p} />;
    case "quiz":
      return <QuizBlock spec={spec} {...p} />;
    case "progress":
      return <ProgressBlock spec={spec} {...p} />;
    case "kv":
      return <KvBlock spec={spec} {...p} />;
    case "form":
      return <FormBlock spec={spec} {...p} readOnly={readOnly} />;
    case "route":
      return <RouteBlock spec={spec} {...p} />;
    case "sources":
      return <SourcesBlock spec={spec} {...p} />;
    case "outline":
      return <OutlineBlock spec={spec} {...p} />;
    case "draft":
      return <DraftBlock spec={spec} {...p} />;
    case "quote":
      return <QuoteBlock spec={spec} {...p} />;
    case "kline":
      return <KlineBlock spec={spec} {...p} />;
    case "intraday":
      return <IntradayBlock spec={spec} {...p} />;
    case "stocklist":
      return <StockListBlock spec={spec} {...p} />;
    case "weibo_posts":
      return <WeiboPostsBlock spec={spec} {...p} />;
    case "weibo_hot":
      return <WeiboHotBlock spec={spec} {...p} />;
    case "zhihu_hot":
      return <ZhihuHotBlock spec={spec} {...p} />;
    case "zhihu_answers":
      return <ZhihuAnswersBlock spec={spec} {...p} />;
    case "feishu_events":
      return <FeishuEventsBlock spec={spec} {...p} />;
    case "feishu_doc":
      return <FeishuDocBlock spec={spec} {...p} />;
    case "bili_videos":
      return <BiliVideosBlock spec={spec} {...p} />;
    case "bili_rank":
      return <BiliRankBlock spec={spec} {...p} />;
    case "bili_video":
      return <BiliVideoBlock spec={spec} {...p} />;
    case "bili_comments":
      return <BiliCommentsBlock spec={spec} {...p} />;
    case "bili_danmaku":
      return <BiliDanmakuBlock spec={spec} {...p} />;
    case "bili_subtitle":
      return <BiliSubtitleBlock spec={spec} {...p} />;
    case "blog_draft":
      return <BlogDraftBlock spec={spec} {...p} readOnly={readOnly} />;
    case "blog_status":
      return <BlogStatusBlock spec={spec} {...p} readOnly={readOnly} />;
    case "blog_published":
      return <BlogPublishedBlock spec={spec} {...p} readOnly={readOnly} />;
  }
}

/** 流式期间:还没有任何可显示的数据时继续显示骨架(不要先画一个空壳再长出来)。 */
function hasContent(spec: IuiSpec): boolean {
  switch (spec.type) {
    case "table":
      return spec.columns.length > 0 && spec.rows.length > 0;
    case "chart":
      return spec.series.some((s) => s.values.some((v) => v !== null));
    case "stats":
    case "steps":
    case "compare":
    case "timeline":
    case "suggestions":
      return spec.items.length > 0;
    case "tabs":
      // 分段里嵌了组件:等整块写完再画(嵌套的计算器/表单需要完整数据)。
      return spec.tabs.length > 0 && !spec.tabs.some((t) => t.block);
    case "cards":
    case "progress":
    case "kv":
      return spec.items.length > 0;
    case "gallery":
      return spec.images.length > 0;
    case "swatches":
      return spec.colors.length > 0;
    case "tiles":
      return spec.items.length > 0;
    case "route":
      return spec.stops.length > 1;
    case "recipe":
      return spec.ingredients.length > 0;
    case "quiz":
      return spec.questions.length > 0;
    case "form":
      return spec.fields.length > 0;
    case "choice":
      return spec.options.length > 0;
    case "calculator":
      return spec.inputs.length > 0 && spec.outputs.length > 0;
    case "callout":
      return spec.body.length > 0;
    case "sources":
    case "outline":
      return spec.items.length > 0;
    case "draft":
      return spec.variants.length > 0;
    case "quote":
    case "stocklist":
      return spec.items.length > 0;
    case "kline":
      return spec.rows.length > 0;
    case "intraday":
      return spec.points.length > 0;
    case "weibo_posts":
    case "weibo_hot":
    case "zhihu_hot":
    case "feishu_events":
      return spec.items.length > 0;
    case "zhihu_answers":
      return spec.items.length > 0 || !!spec.question;
    case "feishu_doc":
      return spec.title.length > 0;
    case "bili_videos":
    case "bili_rank":
    case "bili_comments":
      return spec.items.length > 0;
    case "bili_video":
      return spec.title.length > 0;
    case "bili_danmaku":
      return spec.items.length > 0 || spec.density.length > 0;
    case "bili_subtitle":
      return spec.lines.length > 0;
    case "blog_draft":
      return spec.body.length > 0;
    case "blog_status":
    case "blog_published":
      return spec.id.length > 0;
  }
}

export type IuiBlockProps = {
  code: string;
  /** 所在消息仍在流式生成。 */
  live?: boolean;
  readOnly?: boolean;
};

export function IuiBlock({ code, live, readOnly }: IuiBlockProps) {
  const outcome = useMemo(() => {
    // Privileged references bypass tolerant content parsing. They are never nested IuiSpec values.
    const system = parseSystemActionReference(code)
    if (system) return live ? { kind: "skeleton" as const, type: "form" as const } : { kind: "system" as const, id: system.proposalId }
    // 输入预测块(OCV5-375)只给输入框用,回答里不显示,流式中也不出骨架。
    if (isNextBlockCode(code, !!live)) return { kind: "hidden" as const };
    const parsed = parseUiBlock(code, !!live);
    if (!parsed.ok) {
      if (live && parsed.reason !== "too_large") {
        // 还在写:猜一下类型给对应骨架。
        const t = /"type"\s*:\s*"([a-z_]+)"/i.exec(code)?.[1];
        return { kind: "skeleton" as const, type: resolveType(t) ?? undefined };
      }
      return { kind: "raw" as const, message: parsed.reason === "too_large" ? "组件内容过大,已按原文显示" : "组件内容无法解析,已按原文显示" };
    }
    const streaming = !parsed.complete;
    const v = validateSpec(parsed.value, streaming);
    if (!v.ok) {
      if (streaming) return { kind: "skeleton" as const, type: resolveType(parsed.value.type) ?? undefined };
      return { kind: "unknown" as const, raw: parsed.value };
    }
    if (streaming && (WAIT_FOR_COMPLETE.has(v.spec.type) || !hasContent(v.spec))) return { kind: "skeleton" as const, type: v.spec.type };
    return { kind: "ok" as const, spec: v.spec, notes: v.notes, streaming };
  }, [code, live]);

  switch (outcome.kind) {
    case "system":
      return <BlockBoundary resetKey={code} fallback={<BodyMarkdown text="系统操作暂不可用，请稍后重新核验。" />}><SystemActionBlock proposalId={outcome.id} readOnly={readOnly} /></BlockBoundary>;
    case "hidden":
      return null;
    case "skeleton":
      return <Skeleton kind={outcome.type} />;
    case "raw":
      return <RawFallback code={code} message={outcome.message} />;
    case "unknown":
      return <UnknownFallback raw={outcome.raw} code={code} />;
    case "ok":
      return (
        <BlockBoundary resetKey={code} fallback={<BodyMarkdown text={safeMarkdown(outcome.spec)} />}>
          <LegacyCardPolicyProvider readOnly={readOnly} live={!!live || outcome.streaming}>
            {renderSpec(outcome.spec, outcome.notes, outcome.streaming, readOnly)}
          </LegacyCardPolicyProvider>
        </BlockBoundary>
      );
  }
}

function safeMarkdown(spec: IuiSpec): string {
  try {
    return specToMarkdown(spec);
  } catch {
    return "";
  }
}

/** 未知类型 / 校验失败:有标题和条目就转成列表,否则原文。 */
function UnknownFallback({ raw, code }: { raw: Record<string, unknown>; code: string }) {
  const title = typeof raw.title === "string" ? raw.title : undefined;
  const items = Array.isArray(raw.items) ? raw.items : undefined;
  if (items && items.length > 0) {
    const lines = items
      .map((it) =>
        typeof it === "string" || typeof it === "number"
          ? String(it)
          : it && typeof it === "object"
            ? Object.values(it as Record<string, unknown>)
                .filter((v) => typeof v === "string" || typeof v === "number")
                .join(" —— ")
            : "",
      )
      .filter(Boolean)
      .map((l) => `- ${l}`);
    if (lines.length > 0) return <BodyMarkdown text={[...(title ? [`**${title}**`, ""] : []), ...lines].join("\n")} />;
  }
  return <RawFallback code={code} message="这个组件无法显示,已按原文显示" />;
}
