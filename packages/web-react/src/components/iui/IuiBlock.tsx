/**
 * Intelligent UI(OCV5-361)—— ```ui 块入口:解析 → 校验 → 分派到原生组件。
 *
 * 不让消息崩溃的三道兜底:
 *   1. 解析/校验失败 → 原文代码块 + 一行说明(或能转的转成 Markdown);
 *   2. 流式半截 → 先渲染已确定部分,否则显示与最终外形接近的骨架;
 *   3. 组件渲染异常 → 组件级错误边界,显示该组件的 Markdown 版本。
 */
import { Component, type ReactNode, useMemo } from "react";
import { CalculatorBlock } from "./CalculatorBlock";
import { ChartBlock } from "./ChartBlock";
import { KvBlock, ProgressBlock, RouteBlock } from "./InfoBlocks";
import { FormBlock, QuizBlock, RecipeBlock } from "./InteractiveBlocks";
import { CardsBlock, GalleryBlock, SwatchesBlock, TilesBlock } from "./MediaBlocks";
import { TableBlock } from "./TableBlock";
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
const WAIT_FOR_COMPLETE = new Set(["calculator", "choice", "suggestions", "callout", "quiz", "form", "recipe"]);

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
    case "skeleton":
      return <Skeleton kind={outcome.type} />;
    case "raw":
      return <RawFallback code={code} message={outcome.message} />;
    case "unknown":
      return <UnknownFallback raw={outcome.raw} code={code} />;
    case "ok":
      return (
        <BlockBoundary resetKey={code} fallback={<BodyMarkdown text={safeMarkdown(outcome.spec)} />}>
          {renderSpec(outcome.spec, outcome.notes, outcome.streaming, readOnly)}
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
