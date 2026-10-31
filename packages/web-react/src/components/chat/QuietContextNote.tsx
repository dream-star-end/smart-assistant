import { Tooltip } from "../ui/Tooltip";
import { isContextCompactionMessage, normalizeToolForDisplay, type ToolLike } from "../tool/format";

export const QUIET_CONTEXT_LINE = "已在后台整理较早的对话";
export const QUIET_CONTEXT_EXPLANATION =
  "对话较长，系统已自动整理较早内容，原始记录仍完整保存，不影响继续聊天。";

function groupDigits(value: number): string {
  return Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function roundedCount(value: unknown): number | null {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** 整理前后的 token 数。缺一侧就不凑对，不展示半句。 */
export function quietContextDetail(message: ToolLike): string {
  if (!isContextCompactionMessage(message)) return QUIET_CONTEXT_EXPLANATION;
  const input = normalizeToolForDisplay(message).input;
  const before = roundedCount(input?.tokensBefore ?? input?.beforeTokens);
  const after = roundedCount(input?.tokensAfter ?? input?.afterTokens);
  if (before == null || after == null) return QUIET_CONTEXT_EXPLANATION;
  return `${QUIET_CONTEXT_EXPLANATION} 整理前约 ${groupDigits(before)} / 整理后约 ${groupDigits(after)}`;
}

/** 过程里的一条淡灰记录。说明在悬停和键盘焦点上，不做成工具卡。 */
export function QuietContextNote({ message }: { message: ToolLike }) {
  const detail = quietContextDetail(message);
  return (
    <Tooltip content={detail}>
      <button
        type="button"
        data-testid="quiet-context-note"
        className="max-w-full cursor-default truncate bg-transparent p-0 text-left text-meta text-faint outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        {QUIET_CONTEXT_LINE}
      </button>
    </Tooltip>
  );
}
