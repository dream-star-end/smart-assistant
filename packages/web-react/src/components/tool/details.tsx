import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { ToolLike } from "./format";

const DETAIL_CHUNK = 64 * 1024;

export type ToolDetailSection = {
  key: string;
  label: string;
  value: unknown;
  note?: string;
};

const TOOL_SHELL_KEYS = new Set([
  "id",
  "role",
  "ts",
  "status",
  "toolName",
  "toolUseId",
  "tool_use_id",
  "durationMs",
  "cancelled",
  "inputJson",
  "partialJson",
  "inputPreview",
  "outputJson",
  "output",
  "text",
  "bashTail",
  "error",
]);

function canonicalValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        return JSON.stringify(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function displayValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function explicitTruncation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).truncated === true;
}

function concealShellCommand(value: unknown, hiddenCommand: string): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        return concealShellCommand(JSON.parse(trimmed), hiddenCommand);
      } catch {
        // 非 JSON 的真实结果文本继续按字符串处理。
      }
    }
    return hiddenCommand && value.includes(hiddenCommand)
      ? value.replaceAll(hiddenCommand, "[已隐藏的工具命令]")
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => concealShellCommand(item, hiddenCommand));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      key === "command" ? "[已隐藏的工具命令]" : concealShellCommand(nested, hiddenCommand),
    ]),
  );
}

/**
 * Build the user-data disclosure independently from semantic renderers. A rich
 * preview can never accidentally consume or hide future persisted fields.
 */
export function buildToolDetailSections(
  message: ToolLike,
  options: { hideInput?: boolean; hiddenCommand?: string } = {},
): ToolDetailSection[] {
  const raw = message as ToolLike & Record<string, unknown>;
  const sections: ToolDetailSection[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, value: unknown, note?: string) => {
    if (value === undefined || value === null || value === "") return;
    const safeValue = options.hiddenCommand ? concealShellCommand(value, options.hiddenCommand) : value;
    const canonical = canonicalValue(safeValue);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sections.push({ key, label, value: safeValue, note });
  };

  if (!options.hideInput) {
    if (raw.inputJson !== undefined) {
      push("inputJson", "输入", raw.inputJson);
    } else if (raw.partialJson) {
      push("partialJson", "流式输入", raw.partialJson, "当前记录仅含尚未完成的流式输入。");
    } else if (raw.inputPreview) {
      push("inputPreview", "输入预览", raw.inputPreview, "当前记录仅保存了输入预览。");
    }
  }

  push(
    "outputJson",
    "结构化结果",
    raw.outputJson,
    explicitTruncation(raw.outputJson) ? "上游返回内容已截断，以下为当前记录已保存的全部内容。" : undefined,
  );
  push("output", "结果", raw.output);
  push("text", "文本结果", raw.text);
  if (raw.bashTail) {
    const note = raw.bashTail.truncatedHead
      ? `当前记录仅保存输出尾部${raw.bashTail.totalBytes ? `，原输出共 ${raw.bashTail.totalBytes.toLocaleString()} 字节` : ""}。`
      : undefined;
    push("bashTail", "终端输出", raw.bashTail.tail, note);
  }
  if (raw.error !== undefined && typeof raw.error !== "boolean") {
    push("error", "错误详情", raw.error);
  }

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_") || TOOL_SHELL_KEYS.has(key) || value === undefined) continue;
    extras[key] = value;
  }
  if (Object.keys(extras).length > 0) push("extras", "附加结果", extras);

  return sections;
}

function ProgressiveValue({ value }: { value: unknown }) {
  const text = displayValue(value);
  const [visibleChars, setVisibleChars] = useState(DETAIL_CHUNK);
  const visible = Math.min(visibleChars, text.length);
  return (
    <>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-fg [overflow-wrap:anywhere]">
        {text.slice(0, visible)}
      </pre>
      {visible < text.length && (
        <button
          type="button"
          onClick={() => setVisibleChars((current) => current + DETAIL_CHUNK)}
          className="mt-2 inline-flex min-h-8 items-center rounded-full bg-hover px-3 text-xs font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          继续显示（还有 {(text.length - visible).toLocaleString()} 个字符）
        </button>
      )}
    </>
  );
}

export function ToolResultDetails({ sections }: { sections: ToolDetailSection[] }) {
  const [open, setOpen] = useState(false);
  if (sections.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border/80 pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn("text-faint transition-transform", open && "rotate-90")}
        />
        结果详情
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {sections.map((section) => (
            <section key={section.key}>
              <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint">
                {section.label}
              </div>
              {section.note && (
                <div className="mb-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                  {section.note}
                </div>
              )}
              <ProgressiveValue value={section.value} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
