/**
 * InspectorPanel —— 产物详情列(Codex 桌面版式的第三列)。
 *
 * 点击会话消息流中的产物(工具卡表头入口 / diff·输出截断处「查看全文」)后,
 * 在主消息流右侧弹出本面板,以**全文模式**(ToolBodyFullContext=true,各截断上限放开)
 * 渲染同一条 tool 消息:文件编辑 diff 全文、终端命令与输出全文、读文件/检索结果全文等。
 *
 * 布局接入(App.tsx):
 *   - 桌面(md+):作为根 flex 的第三列 <aside> 内联渲染,与 Sidebar | main 并列;
 *   - 窄屏:不挤三列,复用 Sheet side="bottom" 贴底抽屉呈现同一 InspectorPanelContent。
 *
 * 数据:target.message 持 ChatSocket 就地 mutate 的消息对象引用,App 随 version 重渲
 * 时面板自然读到最新流式内容(运行中的工具在面板里也会边流边更新)。
 * 状态徽标与卡片共用 {@link resolveToolStatus}(T-05):卡片「受阻/未成功」面板就不会是「完成/已结束」。
 */
import { Check, Copy, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { ToolBody } from "./tool/bodies";
import {
  ToolBodyFullContext,
  ToolHeaderLabelContext,
  type ArtifactInspectTarget,
} from "./tool/context";
import {
  type DisplayTool,
  asArr,
  asStr,
  normalizeToolForDisplay,
  stripShellWrapperForDisplay,
} from "./tool/format";
import { diffLines } from "./tool/lineDiff";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { parseShellEnvelope } from "./tool/shellEnvelope";
import { resolveToolStatus } from "./tool/status";
import { toneTileClass } from "./tool/tone";
import { Badge, IconButton, Spinner, useToast } from "./ui";

function codexChangesText(input: Record<string, unknown> | null): string {
  return asArr(input?.changes)
    .map((c) => (c && typeof c === "object" ? asStr((c as Record<string, unknown>).diff) : ""))
    .filter(Boolean)
    .join("\n");
}

function formattedInput(input: Record<string, unknown> | null): string {
  if (!input) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "";
  }
}

/**
 * 「复制全文」按工具类型取**面板里实际展示的正文**(T-04):
 *   - Edit → 行级 diff 文本(与面板 DiffView 同源 diffLines);codex apply_patch 形状取 changes[].diff;
 *   - Write → 文件内容;
 *   - Bash → `$ 命令` + 输出(Cursor 信封先解成 stdout/stderr,不复制 JSON 外壳);
 *   - 其余 → output,没有 output 才回退格式化的 input。
 * 之前一律优先复制 output:Edit/Write 完成后 output 是 "The file has been updated." 这类状态串,
 * 面板展示的是 diff,复制到的却是一句废话。
 */
export function inspectorCopyText(display: DisplayTool): string {
  const { name, input, tool } = display;
  const output = typeof tool.output === "string" ? tool.output : "";
  switch (name) {
    case "Edit": {
      const oldStr = asStr(input?.old_string);
      const newStr = asStr(input?.new_string);
      if (oldStr || newStr) {
        return diffLines(oldStr, newStr)
          .map((row) => `${row.sign}${row.text}`)
          .join("\n");
      }
      return codexChangesText(input) || output || formattedInput(input);
    }
    case "Write":
      return asStr(input?.content) || codexChangesText(input) || output || formattedInput(input);
    case "Bash": {
      const command = stripShellWrapperForDisplay(asStr(input?.command));
      const env = parseShellEnvelope(output);
      const streams = env
        ? [env.stdout, env.stderr].filter(Boolean).join(env.stdout && !env.stdout.endsWith("\n") ? "\n" : "")
        : output || asStr(tool.bashTail?.tail);
      return [command ? `$ ${command}` : "", streams].filter(Boolean).join("\n");
    }
    default:
      return output.trim() ? output : formattedInput(input);
  }
}

function CopyIconButton({ getText }: { getText: () => string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <IconButton
      aria-label="复制全文"
      title="复制全文"
      size="sm"
      shape="square"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          toast("已复制全文", "success");
          setTimeout(() => setDone(false), 1500);
        } catch {
          // 剪贴板不可用(非安全上下文 / 权限拒绝):不能再静默,给用户一个出口(T-19)。
          toast("复制失败，请手动选中文本复制", "error");
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
    </IconButton>
  );
}

/** 面板内容(头 + 全文体)。桌面 aside 与移动 Sheet 共用。`titleId` 供外层容器 aria-labelledby。 */
export function InspectorPanelContent({
  target,
  onClose,
  titleId,
}: {
  target: ArtifactInspectTarget;
  onClose: () => void;
  titleId?: string;
}) {
  const display = normalizeToolForDisplay(target.message);
  const meta = resolveToolMeta(display.name, display.input);
  const Icon = meta.icon;
  const summary = toolSummary(display.name, display.input);
  const tool = display.tool;
  const status = resolveToolStatus(display);
  const fallbackTitleId = useId();
  const headingId = titleId ?? fallbackTitleId;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3 header-safe-t">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            toneTileClass(meta.tone),
          )}
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="text-body font-semibold text-fg">
              {meta.label}
            </h2>
            {status.isRunning ? (
              <>
                <span className="sr-only">{status.label}</span>
                <Spinner size={13} className="text-accent" />
              </>
            ) : (
              <Badge tone={status.tone}>{status.label}</Badge>
            )}
          </div>
          {summary && (
            <div className="mt-0.5 truncate font-mono text-xs text-muted" title={summary}>
              {summary}
            </div>
          )}
        </div>
        <CopyIconButton getText={() => inspectorCopyText(normalizeToolForDisplay(target.message))} />
        <IconButton
          aria-label="关闭详情面板"
          size="sm"
          shape="square"
          data-inspector-close=""
          onClick={onClose}
        >
          <X size={16} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [&>*:first-child]:mt-0">
        <ToolBodyFullContext.Provider value={true}>
          <ToolHeaderLabelContext.Provider value={meta.label}>
            <ToolBody name={display.name} input={display.input} tool={tool} />
          </ToolHeaderLabelContext.Provider>
        </ToolBodyFullContext.Provider>
      </div>
    </div>
  );
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

/**
 * 桌面第三列:内联 aside(与 Sidebar/main 并列)。
 * 焦点管理(T-24):打开/切换目标时焦点进面板(关闭按钮),卸载时归还到打开它的那个入口;
 * Escape 关闭 —— 但焦点在输入框/富文本里时不抢(用户按 Esc 多半是取消输入法或清空,不是关面板),
 * Radix 弹层已消费的 Escape 也让位。
 */
export function InspectorPanel({
  target,
  onClose,
}: {
  target: ArtifactInspectTarget;
  onClose: () => void;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Radix 弹层(Dialog/Sheet/Popover)处理过的 Escape 会 preventDefault,不抢。
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isEditableTarget(e.target) && !asideRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 每次换目标(点了另一张卡的入口)都记下当时的焦点元素并把焦点移进面板;
  // 面板整体卸载时把焦点还给最后那个入口。
  // biome-ignore lint/correctness/useExhaustiveDependencies: target 只作"换了目标"的触发信号,effect 体内不读它
  useEffect(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !asideRef.current?.contains(active)
    ) {
      returnFocusRef.current = active;
    }
    const raf = requestAnimationFrame(() => {
      asideRef.current?.querySelector<HTMLElement>("[data-inspector-close]")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [target]);

  useEffect(
    () => () => {
      const el = returnFocusRef.current;
      if (el?.isConnected) el.focus();
    },
    [],
  );

  return (
    <aside
      ref={asideRef}
      aria-labelledby={titleId}
      className="flex min-h-0 w-[clamp(20rem,36vw,34rem)] shrink-0 flex-col border-l border-border"
    >
      <InspectorPanelContent target={target} onClose={onClose} titleId={titleId} />
    </aside>
  );
}
