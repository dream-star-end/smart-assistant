/**
 * 动作类型（DESIGN_MANUS_A §5）：在 tool/meta.ts 的工具分类之上再叠一层「终端 / 文件 / 网页 /
 * 搜索 / 其他」五类，供面板 A 栏类型标签、rail 图标砖、窄屏 chip 使用。
 * 不重新定义工具标签 / 图标 / 状态 —— 那些仍走 resolveToolMeta / resolveToolStatus。
 */
import { FileText, Globe, type LucideIcon, Search, Terminal, Wrench } from "lucide-react";
import { asStr, detectShellFileWrites, stripShellWrapperForDisplay } from "../tool/format";
import { MEMORY_UPDATE_META, type ToolTone, detectOcCli, parseMcpName, resolveToolMeta } from "../tool/meta";
import { AGENT_PANEL_STRINGS, type ActionKindKey } from "./strings";

export type ActionKind = ActionKindKey;

export type ActionKindMeta = { kind: ActionKind; label: string; icon: LucideIcon; tone: ToolTone };

const KIND_META: Record<ActionKind, Omit<ActionKindMeta, "label">> = {
  file: { kind: "file", icon: FileText, tone: "success" },
  web: { kind: "web", icon: Globe, tone: "info" },
  search: { kind: "search", icon: Search, tone: "neutral" },
  terminal: { kind: "terminal", icon: Terminal, tone: "accent" },
  other: { kind: "other", icon: Wrench, tone: "neutral" },
};

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit", "apply_patch"]);
const SEARCH_TOOLS = new Set(["WebSearch", "Grep", "Glob", "McpSearch", "search_tool", "SearchExtraTools"]);
const SHELL_TOOLS = new Set(["Bash", "Shell", "run_terminal_command", "run_terminal_cmd"]);
const FILE_OC_CLIS = new Set(["oc-report", "oc-docx", "oc-pdf", "oc-xlsx", "oc-slides", "oc-poster"]);
const WEB_OC_CLIS = new Set(["oc-browser", "oc-web", "oc-web-context"]);
const SEARCH_OC_CLIS = new Set(["oc-lit", "oc-rank"]);
const SEARCH_MCP_OPS = new Set([
  "openclaude-memory:session_search",
  "openclaude-memory:archival_search",
  "scansci-pdf:scansci_pdf_search",
]);
/** 浏览器 MCP 里「跑代码」类 op 归终端，其余归网页。 */
const BROWSER_TERMINAL_OPS = new Set(["browser_evaluate", "browser_run_code"]);

export function resolveActionKindKey(name: string, input?: Record<string, unknown> | null): ActionKind {
  if (FILE_TOOLS.has(name)) return "file";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (name === "WebFetch") return "web";
  if (input && resolveToolMeta(name, input) === MEMORY_UPDATE_META) return "file";
  if (SHELL_TOOLS.has(name)) {
    const command = stripShellWrapperForDisplay(asStr(input?.command));
    if (detectShellFileWrites(command)) return "file";
    const cli = detectOcCli(command);
    if (cli) {
      if (FILE_OC_CLIS.has(cli)) return "file";
      if (WEB_OC_CLIS.has(cli)) return "web";
      if (SEARCH_OC_CLIS.has(cli)) return "search";
    }
    return "terminal";
  }
  const mcp = parseMcpName(name);
  if (mcp) {
    if (mcp.server === "browser") return BROWSER_TERMINAL_OPS.has(mcp.op) ? "terminal" : "web";
    if (mcp.server === "web-context") return "web";
    if (SEARCH_MCP_OPS.has(`${mcp.server}:${mcp.op}`)) return "search";
  }
  return "other";
}

export function resolveActionKind(name: string, input?: Record<string, unknown> | null): ActionKindMeta {
  const kind = resolveActionKindKey(name, input);
  return { ...KIND_META[kind], label: AGENT_PANEL_STRINGS.kinds[kind] };
}
