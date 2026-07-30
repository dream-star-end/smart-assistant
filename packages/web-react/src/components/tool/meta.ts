/**
 * 工具图标 / 标签 / 摘要的解析层（Aurora 视觉，功能基线对齐现网
 * `_TOOL_ICONS` / `_TOOL_LABELS` / `_MCP_SERVER_META` / `_MCP_OP_META` / `_toolSummary`）。
 *
 * 兼容 v3/Codex 历史工具名：Codex wrapper 会先在 format 层归一化；
 * 少量非 wrapper Codex item 在这里给出友好标签/摘要。
 * 图标统一走 lucide-react（Aurora 设计系统的图标权威源），不再内联 SVG 字符串。
 */
import {
  AppWindow,
  Archive,
  BarChart3,
  Bot,
  Boxes,
  Brain,
  Camera,
  Clock,
  Eye,
  FilePlus,
  FileText,
  FolderOpen,
  FormInput,
  Globe,
  Image as ImageIcon,
  Keyboard,
  Layers,
  ListChecks,
  Mic,
  MousePointer2,
  Music,
  NotebookPen,
  Pencil,
  Plug,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  Video,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { agentDisplayName } from "../chat/agentNames";
import { asArr, asStr, detectShellFileWrites, parseCodexTypeName, shortPath, stripShellWrapperForDisplay } from "./format";

/** 工具卡图标底色语义(对齐设计稿 aurora-conversation-cards 的 .tic.tn-* 分色)。 */
export type ToolTone = "accent" | "success" | "info" | "warning" | "neutral";
export type ToolMeta = { icon: LucideIcon; label: string; tone?: ToolTone };

// ── builtin claude-code 工具(tone 对齐设计稿:终端紫/编辑写入绿/读取搜索灰/网页蓝)──
const TOOL_META: Record<string, ToolMeta> = {
  Bash: { icon: Terminal, label: "终端", tone: "accent" },
  Read: { icon: FileText, label: "读取文件", tone: "neutral" },
  Edit: { icon: Pencil, label: "编辑文件", tone: "success" },
  Write: { icon: FilePlus, label: "写入文件", tone: "success" },
  Grep: { icon: Search, label: "搜索内容", tone: "neutral" },
  Glob: { icon: FolderOpen, label: "搜索文件", tone: "neutral" },
  WebFetch: { icon: Globe, label: "网页抓取", tone: "info" },
  WebSearch: { icon: Globe, label: "网页搜索", tone: "info" },
  TodoWrite: { icon: ListChecks, label: "任务列表", tone: "accent" },
  NotebookEdit: { icon: NotebookPen, label: "笔记本", tone: "neutral" },
  Task: { icon: Bot, label: "子任务", tone: "accent" },
  Agent: { icon: Bot, label: "子任务", tone: "accent" },
  // CCB Kairos cron 工具(已在商业容器禁用,agent 侧改走 openclaude-memory 的
  // reminder 工具族);保留 meta 让历史会话的卡片仍有语义标签。
  CronList: { icon: Clock, label: "定时任务列表", tone: "accent" },
  CronCreate: { icon: Clock, label: "创建定时任务", tone: "accent" },
  CronDelete: { icon: Clock, label: "删除定时任务", tone: "accent" },
  // v3/Codex 历史会话里可能出现的非标准 toolName，补语义标签避免裸英文。
  Skill: { icon: Sparkles, label: "启用技能", tone: "accent" },
  TaskOutput: { icon: Bot, label: "子任务结果", tone: "accent" },
  EnterPlanMode: { icon: ListChecks, label: "进入计划模式", tone: "accent" },
  ExitPlanMode: { icon: ListChecks, label: "退出计划模式", tone: "accent" },
  TaskStop: { icon: Bot, label: "停止子任务", tone: "warning" },
  delegate_task: { icon: Bot, label: "委托子任务", tone: "accent" },
  delegate_tasks: { icon: Users, label: "并行委派", tone: "accent" },
};

const CODEX_TYPE_META: Record<string, ToolMeta> = {
  imageView: { icon: Eye, label: "查看图片", tone: "warning" },
  imageGeneration: { icon: ImageIcon, label: "生成图片", tone: "accent" },
  contextCompaction: { icon: Archive, label: "压缩上下文", tone: "neutral" },
  enteredReviewMode: { icon: Bot, label: "进入审阅模式", tone: "accent" },
  exitedReviewMode: { icon: Bot, label: "退出审阅模式", tone: "neutral" },
  dynamicToolCall: { icon: Wrench, label: "工具调用", tone: "neutral" },
  mcpToolCall: { icon: Wrench, label: "MCP 工具", tone: "neutral" },
  userMessage: { icon: Bot, label: "Codex 消息", tone: "neutral" },
  // 子代理生命周期事件(started/completed);存量孤儿消息(toolName 'unknown' + item 在
  // output)也会经 format 层兜底归一化到这里。注:webSearch 恒被归一化为内置 WebSearch
  // (normalizeCodexTool 无失败分支),不需要 codex 级 meta 条目。
  subAgentActivity: { icon: Bot, label: "子代理活动", tone: "accent" },
};

// ── 容器内 oc-* CLI(经 Bash 调用)→ 语义卡:单一权威表 ──
//
// oc-web/oc-lit/… 是通过 `Bash` 执行的命令行(`oc-web extract <url>`),工具名恒为
// "Bash";若不特判就全渲染成通用"终端"卡并把原始命令外露。OC_TOOLS 是所有 oc-* CLI 的
// **唯一权威定义源**:header 图标/标签/底色(resolveToolMeta)与 body 专属卡分派
// (researchCards.OC_BODY_CARDS,以 OcCli 为键做编译期约束)都从这里派生 —— 加新 oc-*
// 工具只需在此登记一处,header 立即生效、body 至少落通用 GenericOcCard(不会再出现
// "加了 header 忘了 body"导致泄漏原始命令的半更新,即历史提交 a1707d54 的那类漂移)。
export const OC_TOOLS = {
  "oc-web": { icon: Globe, label: "网页/文档提取", tone: "info" },
  "oc-web-context": { icon: FileText, label: "网页/文档解析", tone: "info" },
  "oc-browser": { icon: AppWindow, label: "浏览器", tone: "info" },
  "oc-lit": { icon: Search, label: "文献检索", tone: "info" },
  "oc-cite": { icon: FileText, label: "引用铸造", tone: "info" },
  "oc-ingest": { icon: Archive, label: "资料入库", tone: "accent" },
  "oc-litrag": { icon: Brain, label: "文献问答", tone: "accent" },
  "oc-report": { icon: NotebookPen, label: "研究报告", tone: "accent" },
  "oc-rank": { icon: BarChart3, label: "排序打分", tone: "info" },
  "oc-market": { icon: Sparkles, label: "AI 市场", tone: "accent" },
  // 对话内发起技能训练优化/生成评测用例(P2,回环 relay 到容器 gateway 自身 train/gen API)。
  "oc-skill": { icon: Sparkles, label: "技能训练", tone: "accent" },
  "oc-xlsx": { icon: BarChart3, label: "表格生成", tone: "success" },
  "oc-pdf": { icon: FileText, label: "PDF 生成", tone: "success" },
  "oc-docx": { icon: FileText, label: "Word 生成", tone: "success" },
  "oc-slides": { icon: AppWindow, label: "幻灯片生成", tone: "success" },
  "oc-poster": { icon: ImageIcon, label: "海报生成", tone: "success" },
  // 识图/记忆从 MCP 工具迁到 CLI(2026-07-07)后经 Bash 调用,专属卡沿用旧语义
  //(understand_image → "图片理解"眼睛;memory/archival/session_search → "记忆")。
  "oc-vision": { icon: Eye, label: "图片理解", tone: "info" },
  "oc-memory": { icon: Brain, label: "记忆", tone: "accent" },
  "oc-minimax": { icon: Sparkles, label: "媒体生成", tone: "accent" },
  // mmx = oc-minimax 的软链(Dockerfile `ln -sf oc-minimax mmx`);同图标/标签/卡。
  mmx: { icon: Sparkles, label: "媒体生成", tone: "accent" },
  // 应用连接器(webdav/imap/notion/github/feishu):body 专属卡含写操作确认卡
  // (connectorCards.tsx,human-in-the-loop 安全关键)。
  "oc-connect": { icon: Plug, label: "应用连接", tone: "accent" },
  // 市场 Plugin(知识星球/微博等)沿用同一服务端确认账本与确认卡；CLI stdout 只提供
  // 不透明 confirmation id，卡片内容仍由后端权威详情铸造。
  "oc-plugin": { icon: Plug, label: "市场插件", tone: "accent" },
} satisfies Record<string, ToolMeta>;

/** oc-* CLI 名的联合类型(= OC_TOOLS 的键)。body 卡注册表以它为键,保证不会给未登记的
 *  CLI 注册卡片 —— 单一权威的编译期约束。 */
export type OcCli = keyof typeof OC_TOOLS;

// oc-* 程序名只在【命令位置】才算调用:行首(可有前导空白)、shell 分隔符
// (`\n ; & | (`,涵盖 && / ||)之后,允许前导环境变量赋值(`FOO=1 oc-lit`)与绝对/相对
// 路径前缀(`/usr/local/bin/oc-lit`)。这样 `echo oc-web`、`cat oc-web.sh` 这类把 oc-web
// 当参数/文本的命令不会误判成 CLI 调用;lookahead 保证 `oc-lit` 不吞 `oc-litrag`。
// 这是 oc-* 检测的**唯一权威**(旧 researchCards.matchOcTool 已退役,消除双检测漂移:
// 原 matchOcTool 认 env 前缀/路径但漏 `cd && oc-cite`,detectOcCli 认分隔符但漏 env/路径 ——
// 合并两者的覆盖到一处)。
const OC_CLI_RE = new RegExp(
  `(?:^\\s*|[\\n;&|(]\\s*)(?:\\w+=\\S*\\s+)*(?:\\S*/)?(${Object.keys(OC_TOOLS).join("|")})(?=\\s|$)`,
);

/** 从一条 Bash 命令里识别命令位置调用的 oc-* CLI 名(无则 null)。 */
export function detectOcCli(command: string | undefined | null): string | null {
  if (!command) return null;
  const m = OC_CLI_RE.exec(command);
  return m ? (m[1] ?? null) : null;
}

// ── 记忆写入重标(单一权威)──
//
// memdir 范式下,CCB/codex 引擎用原生 Write/Edit 直接写记忆文件(容器内 CLAUDE_CODE_DISABLE_AUTO_MEMORY),
// 不再走已退役的 oc-memory memory 子命令。凡写入命中「记忆目录 / MEMORY.md 索引 / 共享 user.md 画像」
// → header 重标「记忆更新」(Brain 图标 + 语义标签),正文沿用 Write/Edit 的 diff 展示(body 分派仍按
// 原 toolName)。此常量是该重标的**唯一 meta 权威**(定位同 OC_TOOLS 之于 oc-* CLI):不散落各处。
export const MEMORY_UPDATE_META: ToolMeta = { icon: Brain, label: "记忆更新", tone: "accent" };

/** 路径是否命中 agent 记忆(memdir 记忆文件 / MEMORY.md 索引 / 共享 user.md 画像)。记忆写入重标的唯一判定。 */
export function isMemoryFilePath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const p = String(filePath);
  return (
    /(^|\/)\.openclaude\/agents\/[^/]+\/memory\//.test(p) || // memdir 记忆文件
    /(^|\/)\.openclaude\/agents\/[^/]+\/MEMORY\.md$/.test(p) || // MEMORY.md 索引
    /(^|\/)\.openclaude\/user\.md$/i.test(p) // 共享用户画像
  );
}

// ── MCP server 前缀 → 友好 meta（图标 + 基础标签 + tone）──
// 工具名形如 `mcp__<server>__<op>`，先按 server 分类，再按 op 细化。
const MCP_SERVER_META: Record<string, ToolMeta> = {
  browser: { icon: AppWindow, label: "浏览器", tone: "info" },
  "minimax-media": { icon: Sparkles, label: "媒体生成", tone: "accent" },
  "minimax-vision": { icon: Eye, label: "视觉理解", tone: "warning" },
  "openclaude-vision": { icon: Eye, label: "视觉理解", tone: "warning" },
  "openclaude-memory": { icon: Brain, label: "记忆", tone: "accent" },
  "scansci-pdf": { icon: FileText, label: "论文检索", tone: "info" },
  "web-context": { icon: Globe, label: "网页/文档提取", tone: "info" },
  "quant-system": { icon: BarChart3, label: "量化", tone: "info" },
  // codex 引擎内建 MCP 桥(list_mcp_resources 等运维类 op)——归「系统」域,避免裸英文兜底。
  codex: { icon: Server, label: "系统", tone: "neutral" },
};

// ── per-op 覆盖（server 作用域），给更贴切的图标 + 标签 ──
const MCP_OP_META: Record<string, ToolMeta> = {
  // browser
  "browser:browser_navigate": { icon: Globe, label: "打开网页" },
  "browser:browser_navigate_back": { icon: Globe, label: "后退" },
  "browser:browser_take_screenshot": { icon: Camera, label: "截图" },
  "browser:browser_snapshot": { icon: AppWindow, label: "页面快照" },
  "browser:browser_click": { icon: MousePointer2, label: "点击" },
  "browser:browser_type": { icon: Keyboard, label: "输入文本" },
  "browser:browser_fill_form": { icon: FormInput, label: "填写表单" },
  "browser:browser_press_key": { icon: Keyboard, label: "按键" },
  "browser:browser_select_option": { icon: FormInput, label: "选择选项" },
  "browser:browser_evaluate": { icon: Terminal, label: "执行脚本" },
  "browser:browser_run_code": { icon: Terminal, label: "执行代码" },
  "browser:browser_wait_for": { icon: Clock, label: "等待" },
  "browser:browser_close": { icon: AppWindow, label: "关闭浏览器" },
  "browser:browser_tabs": { icon: AppWindow, label: "标签页" },
  "browser:browser_console_messages": { icon: Terminal, label: "控制台" },
  "browser:browser_network_requests": { icon: Globe, label: "网络请求" },
  "browser:browser_pdf_save": { icon: FileText, label: "保存 PDF" },
  "browser:browser_resize": { icon: AppWindow, label: "调整窗口" },
  "browser:browser_hover": { icon: MousePointer2, label: "悬停" },
  "browser:browser_drag": { icon: MousePointer2, label: "拖拽" },
  "browser:browser_file_upload": { icon: FilePlus, label: "上传文件" },
  "browser:browser_handle_dialog": { icon: AppWindow, label: "处理弹窗" },
  // minimax-media
  "minimax-media:text_to_image": { icon: ImageIcon, label: "生成图片" },
  "minimax-media:generate_video": { icon: Video, label: "生成视频" },
  "minimax-media:query_video_generation": { icon: Video, label: "查询视频" },
  "minimax-media:music_generation": { icon: Music, label: "生成音乐" },
  "minimax-media:text_to_audio": { icon: Mic, label: "语音合成" },
  "minimax-media:voice_clone": { icon: Mic, label: "克隆音色" },
  "minimax-media:voice_design": { icon: Mic, label: "设计音色" },
  "minimax-media:list_voices": { icon: Mic, label: "音色列表" },
  "minimax-media:play_audio": { icon: Music, label: "播放音频" },
  // vision
  "minimax-vision:understand_image": { icon: Eye, label: "图片理解" },
  "minimax-vision:web_search": { icon: Globe, label: "联网搜索" },
  "openclaude-vision:understand_image": { icon: Eye, label: "图片理解" },
  // memory
  "openclaude-memory:memory": { icon: Brain, label: "核心记忆" },
  "openclaude-memory:archival_add": { icon: Archive, label: "归档写入" },
  "openclaude-memory:archival_search": { icon: Archive, label: "归档检索" },
  "openclaude-memory:archival_delete": { icon: Archive, label: "归档删除" },
  "openclaude-memory:session_search": { icon: Search, label: "历史检索" },
  "openclaude-memory:create_reminder": { icon: Clock, label: "创建提醒" },
  "openclaude-memory:list_reminders": { icon: Clock, label: "定时任务列表" },
  "openclaude-memory:update_reminder": { icon: Clock, label: "修改定时任务" },
  "openclaude-memory:delete_reminder": { icon: Clock, label: "删除定时任务" },
  "openclaude-memory:delegate_task": { icon: Bot, label: "委托子任务" },
  "openclaude-memory:delegate_tasks": { icon: Users, label: "并行委派" },
  "openclaude-memory:send_to_agent": { icon: Send, label: "发送给子 Agent" },
  "openclaude-memory:skill_list": { icon: Sparkles, label: "技能列表" },
  "openclaude-memory:skill_search": { icon: Sparkles, label: "技能检索" },
  "openclaude-memory:skill_view": { icon: Sparkles, label: "查看技能" },
  "openclaude-memory:skill_save": { icon: Sparkles, label: "保存技能" },
  "openclaude-memory:skill_delete": { icon: Sparkles, label: "删除技能" },
  "openclaude-memory:skill_propose": { icon: Sparkles, label: "提议技能" },
  "openclaude-memory:request_review": { icon: ShieldCheck, label: "申请质量审查" },
  "openclaude-memory:ask_gpt55_codex": { icon: Bot, label: "Codex 审查" },
  // codex 内建 MCP 资源清单(op 无摘要,空态即全部信息)。
  "codex:list_mcp_resources": { icon: Boxes, label: "MCP 资源列表" },
  "codex:list_mcp_resource_templates": { icon: Layers, label: "MCP 资源模板" },
  // web-context
  "web-context:web_context_extract_url": { icon: Globe, label: "网页提取" },
  "web-context:web_context_parse_file": { icon: FileText, label: "文档解析" },
  // scansci-pdf
  "scansci-pdf:scansci_pdf_download": { icon: FileText, label: "下载论文 PDF" },
  "scansci-pdf:scansci_pdf_batch_download": { icon: FilePlus, label: "批量下载论文" },
  "scansci-pdf:scansci_pdf_search": { icon: Search, label: "搜索论文" },
  "scansci-pdf:scansci_pdf_citation": { icon: FileText, label: "生成引用" },
  "scansci-pdf:scansci_pdf_health_check": { icon: ListChecks, label: "论文源健康检查" },
  "scansci-pdf:scansci_pdf_network_diagnose": { icon: Globe, label: "论文网络诊断" },
  "scansci-pdf:scansci_pdf_source_scores": { icon: BarChart3, label: "论文源评分" },
  "scansci-pdf:scansci_pdf_vpnsci_status": { icon: AppWindow, label: "机构登录状态" },
  "scansci-pdf:scansci_pdf_vpnsci_login": { icon: AppWindow, label: "机构登录" },
  "scansci-pdf:scansci_pdf_vpnsci_test": { icon: AppWindow, label: "测试机构访问" },
  "scansci-pdf:scansci_pdf_parse_list": { icon: FileText, label: "解析论文列表" },
  "scansci-pdf:scansci_pdf_resolve_and_download": { icon: FilePlus, label: "解析并下载" },
};

/** 解析 `mcp__<server>__<op>` → { server, op }；非 MCP 名返回 null。 */
export function parseMcpName(name: string): { server: string; op: string } | null {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return { server: rest, op: "" };
  return { server: rest.slice(0, idx), op: rest.slice(idx + 2) };
}

/** snake_case op → 友好标签（`browser_navigate` → `browser navigate`）。 */
export function humanizeOp(op: string): string {
  return (op || "").replace(/_/g, " ").trim();
}

function commandOp(command: string, cli: string): string {
  const match = new RegExp(`(?:^|[\\n;&|]\\s*)${cli.replace("-", "\\-")}\\s+([\\w-]+)`, "i").exec(command);
  return (match?.[1] ?? "").toLowerCase();
}

function commandFlag(command: string, flag: string): string {
  const match = new RegExp(`(?:^|\\s)--${flag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(command);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function browserCommandArgs(command: string, op: string): string[] {
  if (!op) return [];
  const match = new RegExp(`oc-browser\\s+${op.replace("-", "\\-")}\\b([^\\n;&|]*)`, "i").exec(command);
  if (!match) return [];
  return [...(match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (token) => token[1] ?? token[2] ?? token[3] ?? "",
  );
}

function displayDomain(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value.slice(0, 60);
  }
}

function ocCommandMeta(cli: OcCli, command: string): ToolMeta {
  const base = OC_TOOLS[cli];
  const op = commandOp(command, cli);
  if (cli === "oc-browser") {
    const map: Record<string, ToolMeta> = {
      open: { icon: Globe, label: "打开网页", tone: "info" },
      goto: { icon: Globe, label: "打开网页", tone: "info" },
      snapshot: { icon: AppWindow, label: "读取页面", tone: "info" },
      find: { icon: Search, label: "查找页面", tone: "info" },
      click: { icon: MousePointer2, label: "点击页面", tone: "info" },
      dblclick: { icon: MousePointer2, label: "双击页面", tone: "info" },
      fill: { icon: Keyboard, label: "输入文本", tone: "info" },
      type: { icon: Keyboard, label: "输入文本", tone: "info" },
      press: { icon: Keyboard, label: "按键", tone: "info" },
      screenshot: { icon: Camera, label: "网页截图", tone: "info" },
      "go-back": { icon: Globe, label: "返回上一页", tone: "info" },
      reload: { icon: Globe, label: "刷新网页", tone: "info" },
      close: { icon: XCircle, label: "关闭浏览器", tone: "info" },
    };
    return map[op] ?? base;
  }
  if (cli === "oc-market") {
    const labels: Record<string, string> = {
      search: "搜索 AI 市场",
      installed: "已安装能力",
      detail: "查看市场详情",
      install: "安装市场能力",
      uninstall: "卸载市场能力",
      "publish-skill": "发布技能",
      "publish-agent": "发布智能体",
    };
    return labels[op] ? { ...base, label: labels[op] } : base;
  }
  if (cli === "oc-plugin") {
    const labels: Record<string, string> = {
      list: "可用市场插件",
      catalog: "搜索市场插件",
      call: "调用市场插件",
    };
    return labels[op] ? { ...base, label: labels[op] } : base;
  }
  if (cli === "oc-connect") {
    const labels: Record<string, string> = {
      list: "已连接应用",
      catalog: "搜索应用连接",
      call: "调用应用连接",
    };
    return labels[op] ? { ...base, label: labels[op] } : base;
  }
  if (cli === "oc-web") return { ...base, label: "提取网页内容" };
  return base;
}

function ocCommandSummary(cli: OcCli, command: string): string {
  const op = commandOp(command, cli);
  if (cli === "oc-browser") {
    const args = browserCommandArgs(command, op);
    if (op === "open" || op === "goto" || op === "tab-new") {
      return args[0] ? displayDomain(args[0]) : op;
    }
    if (op === "fill") return (args[1] ?? args[0] ?? op).slice(0, 60);
    if (op === "type" || op === "press" || op === "find") return (args[0] ?? op).slice(0, 60);
    if (op === "click" || op === "dblclick") return args[0] ? `元素 ${args[0]}` : op;
    return commandFlag(command, "filename") || op;
  }
  if (cli === "oc-web") {
    const url = commandFlag(command, "url") || command.match(/https?:\/\/[^\s'";|]+/)?.[0] || "";
    return url ? displayDomain(url) : "";
  }
  const invocation = new RegExp(`${cli.replace("-", "\\-")}\\s+${op}\\s+([^\\s;&|]+)(?:\\s+([^\\s;&|]+))?`, "i").exec(command);
  if (cli === "oc-plugin" || cli === "oc-connect") {
    if (op === "call") return [invocation?.[1], invocation?.[2]?.replaceAll("_", " ")].filter(Boolean).join(" · ");
    if (op === "catalog") return invocation?.[1]?.replace(/^["']|["']$/g, "") ?? "";
    return "";
  }
  if (cli === "oc-market") {
    return invocation?.[1]?.replace(/^["']|["']$/g, "") ?? "";
  }
  return "";
}

/**
 * 为工具名解析图标 + 标签（处理 MCP 名）。
 * 优先级：builtin > MCP per-op > MCP server 兜底 > 通用扳手。
 */
export function resolveToolMeta(
  name: string,
  input?: Record<string, unknown> | null,
): ToolMeta {
  // Bash 命令若调用 oc-* CLI,给专属语义卡而非通用"终端"卡。
  if (name === "Bash" && input) {
    // 展示层剥壳兜底(历史消息带 /bin/bash -lc 包装),否则 oc-*/写文件检测在包装内失配。
    const command = stripShellWrapperForDisplay(asStr(input.command));
    const fileWrite = detectShellFileWrites(command);
    if (fileWrite) {
      // 写入记忆文件(heredoc 写 MEMORY.md/记忆目录等)→ 记忆更新;否则普通写入文件。
      return fileWrite.paths.some(isMemoryFilePath) ? MEMORY_UPDATE_META : TOOL_META.Write;
    }
    const cli = detectOcCli(command);
    if (cli) {
      const ocMeta = OC_TOOLS[cli as OcCli];
      if (ocMeta) return ocCommandMeta(cli as OcCli, command);
    }
  }
  // 原生 Write/Edit 写入记忆文件 → 重标「记忆更新」(body 仍按 Write/Edit 走 diff 展示)。
  if ((name === "Write" || name === "Edit") && isMemoryFilePath(asStr(input?.file_path))) {
    return MEMORY_UPDATE_META;
  }
  if (TOOL_META[name]) return TOOL_META[name];
  const codexType = parseCodexTypeName(name);
  if (codexType && CODEX_TYPE_META[codexType]) return CODEX_TYPE_META[codexType];
  const mcp = parseMcpName(name);
  if (mcp) {
    const srvMeta = MCP_SERVER_META[mcp.server];
    const opMeta = MCP_OP_META[`${mcp.server}:${mcp.op}`];
    // op 级 meta 没单独配 tone 时继承 server tone(再退 accent)。
    if (opMeta) return { ...opMeta, tone: opMeta.tone ?? srvMeta?.tone ?? "accent" };
    const opLabel = humanizeOp(mcp.op) || mcp.server;
    if (srvMeta) return { icon: srvMeta.icon, label: `${srvMeta.label}: ${opLabel}`, tone: srvMeta.tone };
    return { icon: Wrench, label: opLabel, tone: "neutral" };
  }
  return { icon: Wrench, label: name, tone: "neutral" };
}

/** delegate_tasks(并行 fan-out)摘要:`N 个并行子任务`,尽量带首个 goal 截断(防御非数组)。 */
function delegateTasksSummary(input: Record<string, unknown>): string {
  const tasks = asArr(input.tasks);
  const head = `${tasks.length} 个并行子任务`;
  const firstGoal =
    tasks[0] && typeof tasks[0] === "object"
      ? asStr((tasks[0] as Record<string, unknown>).goal)
      : "";
  return firstGoal ? `${head}: ${firstGoal.slice(0, 40)}` : head;
}

/** 工具卡 header 行的紧凑摘要（文件路径 / 命令 / 查询等）。 */
export function toolSummary(name: string, input: Record<string, unknown> | null): string {
  if (!input) return "";
  switch (name) {
    case "Bash": {
      const cmd = stripShellWrapperForDisplay(asStr(input.command));
      const fileWrite = detectShellFileWrites(cmd);
      if (fileWrite) {
        const first = shortPath(fileWrite.paths[0]);
        return fileWrite.paths.length > 1 ? `${first} +${fileWrite.paths.length - 1}` : first;
      }
      // oc-* CLI 只展示解析后的动作/对象，不回显原始 shell 命令及 params。
      const cli = detectOcCli(cmd);
      if (cli) return ocCommandSummary(cli as OcCli, cmd);
      return (asStr(input.description) || cmd.split("\n")[0]).slice(0, 60);
    }
    case "Edit":
      return shortPath(input.file_path);
    case "Read":
      return shortPath(input.file_path);
    case "Write":
      return shortPath(input.file_path);
    case "Grep":
      return `/${asStr(input.pattern)}/`;
    case "Glob":
      return asStr(input.pattern);
    case "WebFetch":
      return asStr(input.url).slice(0, 60);
    case "WebSearch":
      return asStr(input.query).slice(0, 60);
    case "TodoWrite": {
      const todos = asArr(input.todos);
      const done = todos.filter(
        (t) => t && typeof t === "object" && (t as Record<string, unknown>).status === "completed",
      ).length;
      return todos.length ? `${done}/${todos.length}` : "";
    }
    case "NotebookEdit":
      return shortPath(input.notebook_path);
    case "Task":
    case "Agent":
      return (asStr(input.description) || asStr(input.prompt)).slice(0, 60);
    case "Skill":
      return asStr(input.skill) || asStr(input.name);
    case "delegate_task":
      // 委派目标经系统 agent 映射转显示名(hidden-reviewer 等管理 API 隐藏的 agent 无 displayName)。
      return `${input.agentId ? `→ ${agentDisplayName(asStr(input.agentId))} ` : ""}${(
        asStr(input.goal) ||
        asStr(input.message) ||
        asStr(input.prompt)
      ).slice(0, 60)}`;
    case "delegate_tasks":
      return delegateTasksSummary(input);
  }
  const codexType = parseCodexTypeName(name);
  if (codexType) return codexSummary(codexType, input).slice(0, 80);
  const mcp = parseMcpName(name);
  if (!mcp) return "";
  return mcpSummary(mcp.server, mcp.op, input).slice(0, 80);
}

/** MCP per-server 摘要（端口自 `_mcpSummary`，去 codex）。 */
function mcpSummary(server: string, op: string, input: Record<string, unknown>): string {
  if (!input) return "";
  if (server === "browser") {
    if (op === "browser_navigate" || op === "browser_navigate_back") return asStr(input.url);
    if (op === "browser_click" || op === "browser_hover") return asStr(input.element) || asStr(input.ref);
    if (op === "browser_type" || op === "browser_press_key") return asStr(input.text) || asStr(input.key);
    if (op === "browser_take_screenshot") return asStr(input.filename);
    if (op === "browser_evaluate" || op === "browser_run_code")
      return (asStr(input.code) || asStr(input.function)).replace(/\s+/g, " ").slice(0, 60);
    if (op === "browser_wait_for") return asStr(input.text) || `${(input.time as number) || 0}s`;
    return op;
  }
  if (server === "minimax-media") {
    if (op === "text_to_image" || op === "generate_video" || op === "music_generation" || op === "text_to_audio") {
      return (asStr(input.prompt) || asStr(input.text) || asStr(input.lyrics)).slice(0, 60);
    }
    if (op === "query_video_generation") return asStr(input.task_id);
    return op;
  }
  if (server === "minimax-vision" || server === "openclaude-vision") {
    if (op === "understand_image") return (asStr(input.prompt) || asStr(input.question)).slice(0, 60);
    if (op === "web_search") return asStr(input.query);
    return op;
  }
  if (server === "openclaude-memory") {
    if (op === "memory") return `${asStr(input.action) || asStr(input.op) || "read"} ${asStr(input.target) || asStr(input.section)}`.trim();
    if (op === "archival_add" || op === "archival_search" || op === "archival_delete") {
      return asStr(input.query) || asStr(input.id) || asStr(input.text).slice(0, 50);
    }
    if (op === "session_search") return asStr(input.query);
    if (op === "create_reminder") return asStr(input.message) || asStr(input.label) || asStr(input.schedule);
    if (op === "list_reminders") return "";
    if (op === "update_reminder" || op === "delete_reminder") {
      return (asStr(input.message) || asStr(input.label) || asStr(input.id)).slice(0, 50);
    }
    if (op === "delegate_tasks") return delegateTasksSummary(input);
    if (op === "delegate_task" || op === "send_to_agent") {
      // 同 toolSummary 的 delegate_task:系统 agent(如 hidden-reviewer)显示映射名而非裸 id。
      const tgt = input.agentId ? `→ ${agentDisplayName(asStr(input.agentId))} ` : "";
      return `${tgt}${(asStr(input.goal) || asStr(input.message) || asStr(input.prompt)).slice(0, 60)}`;
    }
    if (op === "skill_view" || op === "skill_delete" || op === "skill_save") return asStr(input.name);
    if (op === "skill_search") return asStr(input.query);
    if (op === "ask_gpt55_codex") return (asStr(input.goal) || asStr(input.context)).slice(0, 60);
    return op;
  }
  if (server === "web-context") {
    if (op === "web_context_extract_url") return asStr(input.url).slice(0, 80);
    if (op === "web_context_parse_file") return shortPath(input.file_path);
    return op;
  }
  if (server === "scansci-pdf") {
    if (op === "scansci_pdf_search") return asStr(input.query).slice(0, 60);
    if (op === "scansci_pdf_batch_download") {
      const ids = asArr(input.identifiers);
      return ids.length ? `${ids.length} 篇` : "";
    }
    if (op === "scansci_pdf_download" || op === "scansci_pdf_citation" || op === "scansci_pdf_resolve_and_download") {
      return (asStr(input.identifier) || asStr(input.file_path)).slice(0, 70);
    }
    if (op === "scansci_pdf_parse_list") return shortPath(input.file_path);
    if (op.includes("health") || op.includes("diagnose") || op.includes("source")) return op;
    if (op.includes("vpnsci")) return asStr(input.school) || asStr(input.query) || asStr(input.doi);
    return op;
  }
  return "";
}

function codexSummary(codexType: string, input: Record<string, unknown>): string {
  if (codexType === "imageView") return shortPath(input.path || input.url);
  if (codexType === "imageGeneration") {
    return (asStr(input.prompt) || asStr(input.revisedPrompt) || shortPath(input.savedPath)).slice(0, 60);
  }
  if (codexType === "contextCompaction") return "";
  if (codexType === "enteredReviewMode" || codexType === "exitedReviewMode") return asStr(input.note);
  if (codexType === "dynamicToolCall" || codexType === "mcpToolCall") {
    return asStr(input.tool) || asStr(input.toolName) || asStr(input.name);
  }
  // agentThreadId 是内部 id 无用户价值,摘要只给路径尾段。
  if (codexType === "subAgentActivity") return shortPath(input.agentPath);
  return "";
}
