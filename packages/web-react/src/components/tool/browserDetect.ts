/**
 * 「这一行是不是浏览器操作」的首屏判定(OCV5-374)。App(工具卡进面板的哪一页)和详情面板外壳
 * (要不要显示「浏览器」分区)只需要这一小块(首屏预算);完整解析(动作表、页面、截图)在
 * browserSteps.ts,只随工具卡正文 / 面板浏览器页 / 产出页懒加载。browserStepOf 先过这里的判定,
 * 两边不会分叉。
 */
import type { ToolLike } from "./format";
import { asStr, normalizeToolForDisplay } from "./format";
import { detectOcCli, parseMcpName } from "./meta";

/**
 * 命令位置调用了 oc-browser(动词由 browserSteps 的动作表解析;没登记的动词也算浏览器操作)。
 * 前缀与 meta.detectOcCli 同口径:行首空白、env 赋值、路径、`cd &&` / 管道 / 换行。
 */
const OC_BROWSER_CALL = /(?:^\s*|[\n;&|(]\s*)(?:\w+=\S*\s+)*(?:\S*\/)?oc-browser\s+([a-z-]+)/i;
/** 同一模式的全局版,给 matchAll 逐个取动词。 */
export const OC_BROWSER_CALL_RE = new RegExp(OC_BROWSER_CALL.source, "gi");

/** 工具名 + 输入(归一化后);`command` 是调用方已拿到的 Bash 命令,行里没有输入时用它。 */
export function browserToolShape(
  message: ToolLike,
  command?: string,
): { name: string; input: Record<string, unknown> | null; tool: ToolLike; shell: string } {
  let name = message.toolName ?? "";
  let input: Record<string, unknown> | null = null;
  let tool: ToolLike = message;
  try {
    const display = normalizeToolForDisplay(message);
    name = display.name || name;
    input = display.input && typeof display.input === "object" ? (display.input as Record<string, unknown>) : null;
    tool = display.tool;
  } catch {
    /* 原始行兜底 */
  }
  return { name, input, tool, shell: asStr(input?.command) || command || "" };
}

/** MCP browser_* 任一操作,或命令位置调用了 oc-browser。 */
export function isBrowserStepMessage(message: ToolLike, command?: string): boolean {
  const { name, shell } = browserToolShape(message, command);
  const mcp = parseMcpName(name);
  if (mcp) return mcp.server === "browser";
  return detectOcCli(shell) === "oc-browser" && OC_BROWSER_CALL.test(shell);
}
