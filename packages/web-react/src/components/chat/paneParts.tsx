/**
 * 详情面板各视图共用的小件(OCV5-372 从 InspectorPanel 拆出):复制按钮、增删行数、整卡工具正文、
 * 文件的一次改动。产出页(OutputsView)与步骤页都用,放在这里免得两边互相 import。
 */
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { type DisplayTool, type ToolLike, asStr, normalizeToolForDisplay } from "../tool/format";
import { ToolBodyFullContext, ToolHeaderLabelContext } from "../tool/context";
import { ToolBody } from "../tool/lazyToolBody";
import { resolveToolMeta } from "../tool/meta";
import { resolveToolStatus } from "../tool/status";
import { Badge, IconButton, Spinner, useToast } from "../ui";
import type { FileChangeEntry } from "./workPane";

export function CopyIconButton({
  getText,
  label = "复制全文",
  doneText = "已复制全文",
}: {
  getText: () => string;
  label?: string;
  doneText?: string;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <IconButton
      aria-label={label}
      title={label}
      size="sm"
      shape="square"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setDone(true);
          toast(doneText, "success");
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

export function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

export function FullToolBody({ display }: { display: DisplayTool }) {
  const meta = resolveToolMeta(display.name, display.input);
  return (
    <ToolBodyFullContext.Provider value={true}>
      <ToolHeaderLabelContext.Provider value={meta.label}>
        <ToolBody name={display.name} input={display.input} tool={display.tool} />
      </ToolHeaderLabelContext.Provider>
    </ToolBodyFullContext.Provider>
  );
}

const CHANGE_KIND_LABEL: Record<FileChangeEntry["kind"], string> = {
  edit: "编辑",
  write: "写入",
  patch: "补丁",
  shell: "命令写入",
};

/** 再次 Write 同一文件:按与上次写入全文的 diff 展示(合成一条 Edit 交给同一套 diff 渲染)。 */
function entryDisplay(entry: FileChangeEntry): DisplayTool {
  const display = normalizeToolForDisplay(entry.message);
  if (entry.previousContent === undefined) return display;
  const input = {
    file_path: asStr(display.input?.file_path),
    old_string: entry.previousContent,
    new_string: asStr(display.input?.content),
  };
  return { name: "Edit", input, tool: { ...display.tool, toolName: "Edit", inputJson: input } };
}

export function FileChangeEntryView({
  entry,
  n,
  onOpenStep,
}: {
  entry: FileChangeEntry;
  n: number;
  onOpenStep: (message: ToolLike) => void;
}) {
  const status = resolveToolStatus(normalizeToolForDisplay(entry.message));
  const kind =
    entry.previousContent !== undefined ? "覆盖写入（与上次写入对比）" : CHANGE_KIND_LABEL[entry.kind];
  return (
    <section data-testid="pane-file-change" className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted">
        <span className="font-medium text-fg">第 {n} 次</span>
        <span>{kind}</span>
        {entry.added !== null && entry.removed !== null && status.kind !== "error" && (
          <LineCounts added={entry.added} removed={entry.removed} />
        )}
        {status.isRunning ? (
          <Spinner size={12} className="text-accent" />
        ) : status.kind !== "done" ? (
          <Badge tone={status.tone} size="sm">
            {status.label}
          </Badge>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onOpenStep(entry.message)}
        >
          查看这一步
        </button>
      </div>
      <FullToolBody display={entryDisplay(entry)} />
    </section>
  );
}

