/**
 * 工具卡**展开体**的二级渲染器（Aurora 视觉，功能 parity 现网
 * `_renderToolBody` 及各 `_render*`）。每个 body 接收已解析的 input 与 tool 对象。
 *
 * 含 v3/Codex 历史 item 的紧凑渲染；Codex MCP/dynamic wrapper 大多已在
 * format 层归一化为 native builtin/MCP 工具。
 */
import { Sparkles, FileText } from "lucide-react";
import { lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { SignedImg } from "../chat/media";
import { Badge, Button, Spinner } from "../ui";
import { ExpandControls, ExpandablePre, FULL_TEXT_CAP, useExpandableSlice } from "./expandable";
import { languageForPath, useHighlighter } from "./highlight";
import { diffLines, type DiffRow as LineDiffRow } from "./lineDiff";
import { ReminderStatusCard, renderReminderListCard } from "./memoryReminderCards";
import { renderSkillListCard, renderSkillSearchCard, renderSkillViewCard } from "./skillCards";
import { renderDelegateFanoutCard } from "./delegateFanoutCard";
import { renderMcpResourcesCard } from "./mcpResourceCards";
import { ToolBodyFullContext, ToolInspectOpenContext, useToolCardActions } from "./context";
import { INLINE_SUMMARY_CLS, InlineAction } from "./inlineAction";
import { parseShellEnvelope } from "./shellEnvelope";
import { parseSearchExtraToolsResult, searchExtraToolsQuery } from "../../lib/chat/extraTool";
import { formatLiveActivityAction, mappedLiveActivityLabel } from "../../lib/chat/liveActivityLabel";
import {
  advisorConsultStatusLabel,
  asArr,
  asStr,
  clampStr,
  detectShellFileWrites,
  formatToolDuration,
  formatValue,
  isInternalSubtaskInput,
  isOpaqueArgToolName,
  isSafeHttpUrl,
  isToolInFlight,
  parseCodexTypeName,
  safeSubtaskDescription,
  shortPath,
  stripShellWrapperForDisplay,
  type ToolLike,
} from "./format";
import { parseMcpName } from "./meta";
import { researchToolCard, safeArtifactSrc, WebSearchResultsCard } from "./researchCards";
import { renderReleaseJobCard } from "./releaseCards";

const TaskApprovalCard = lazy(() =>
  import("./taskApprovalCard").then((m) => ({ default: m.TaskApprovalCard })),
);

type Input = Record<string, unknown> | null;
type BodyProps = { input: Input; tool: ToolLike };

// ── 共用原语 ──────────────────────────────────────────────────────────────

/** 等宽块共用类:pre-wrap + break-words,内容再长也不产生横向滚动,纵向由字符上限 + 展开原语控制。 */
const PRE_CLS =
  "mt-1.5 whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-relaxed text-fg";

/**
 * 等宽预格式化块（引用串 / 代码）。
 * 无边框——卡壳本身（ToolCard 的 border-t 体区）已是容器，再加边框会变"框中框"（设计 `.out` 即无边框）。
 * 仅用 bg-code 这层极淡表面做区隔。不再设 max-h 嵌套滚动区(T-09):时间线里的嵌套滚动在移动端
 * 会劫持手势,长度一律靠调用方的字符上限 + 「展开全部」控制。
 */
function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cn(PRE_CLS, className)}>{children}</pre>;
}

function FileMeta({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 text-xs text-faint">{children}</div>;
}

type StatusTone = "success" | "danger" | "muted";

/** 一行状态文案。tone 表达语义色:success 完成 / danger 失败 / muted **进行中**(T-16:进行中 ≠ 成功,不用绿)。 */
function StatusLine({ text, error, tone }: { text: string; error?: boolean; tone?: StatusTone }) {
  if (!text) return null;
  const resolved: StatusTone = tone ?? (error ? "danger" : "success");
  return (
    <div
      className={cn(
        "mt-1.5 text-xs",
        resolved === "danger" ? "text-danger" : resolved === "muted" ? "text-muted" : "text-success",
      )}
    >
      {text}
    </div>
  );
}

// ── 用户面文案(T-27:不把英文开发者术语/原始字段名泄漏到卡片里)──

/** 工具成功回执的已知英文状态串 → 中文;未知原样返回(由调用方降为弱化色)。 */
const KNOWN_STATUS_OUTPUT: Record<string, string> = {
  "the file has been updated.": "文件已更新",
  "the file has been created.": "文件已创建",
  "file created successfully": "文件已创建",
  "file created successfully.": "文件已创建",
  "file updated successfully": "文件已更新",
  "file updated successfully.": "文件已更新",
  "file written successfully": "文件已写入",
  "file written successfully.": "文件已写入",
  "successfully replaced": "已替换",
};

/** 成功状态行:已知英文回执映射中文,未知保持原文。返回 {text, known}。 */
function humanizeStatusOutput(raw: string): { text: string; known: boolean } {
  const trimmed = raw.trim();
  const hit = KNOWN_STATUS_OUTPUT[trimmed.toLowerCase()];
  if (hit) return { text: hit, known: true };
  // "The file /a/b.ts has been updated successfully." 这类带路径的变体:去掉路径后再查一次。
  const m = /^the file .* has been (updated|created)( successfully)?\.?$/i.exec(trimmed);
  if (m) return { text: m[1].toLowerCase() === "created" ? "文件已创建" : "文件已更新", known: true };
  return { text: raw, known: false };
}

/** KvList 已知参数键的中文标签;未知键把下划线换成空格,不再直显 snake_case。 */
const KV_KEY_LABELS: Record<string, string> = {
  url: "地址",
  prompt: "提示词",
  query: "查询",
  results: "结果数",
  allowed_domains: "允许的域名",
  blocked_domains: "屏蔽的域名",
  file_path: "文件",
  path: "路径",
  pattern: "模式",
  command: "命令",
  description: "说明",
  note: "说明",
  summary: "摘要",
  max_chars: "最大字数",
  limit: "上限",
  offset: "起始",
  model: "模型",
  question: "问题",
  text: "文本",
  language: "语言",
  timeout: "超时",
  glob: "文件匹配",
  size: "尺寸",
  style: "风格",
  quality: "质量",
  n: "数量",
  count: "数量",
  status: "状态",
  reason: "原因",
  name: "名称",
  title: "标题",
  id: "编号",
  version: "版本",
  tags: "标签",
  format: "格式",
  duration: "时长",
  voice_id: "音色",
  aspect_ratio: "画幅",
  resolution: "分辨率",
  usage: "用量",
  input_tokens: "输入 token",
  output_tokens: "输出 token",
  total_tokens: "总 token",
  "tokens before": "压缩前 token",
  "tokens after": "压缩后 token",
};

function kvKeyLabel(key: string): string {
  return KV_KEY_LABELS[key] ?? key.replace(/_/g, " ");
}

/** 数字型值做千分位分组(token 数 / 字节数),其余走 formatValue。 */
function kvValueText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return v.toLocaleString();
  return formatValue(v);
}

/** Grep output_mode 原词 → 中文。 */
const OUTPUT_MODE_LABELS: Record<string, string> = {
  content: "匹配内容",
  files_with_matches: "匹配的文件",
  count: "匹配计数",
};

function PromptBlock({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-hover px-3 py-2 text-body text-fg">
      {children}
    </div>
  );
}

/** key-value 列表（不做 raw JSON dump）。 */
function KvList({ obj, skip, maxValueLen = 240 }: { obj: Input; skip?: string[]; maxValueLen?: number }) {
  if (!obj || typeof obj !== "object") return null;
  const skipSet = new Set(skip ?? []);
  const rows = Object.entries(obj).filter(([k, v]) => !skipSet.has(k) && v != null && v !== "");
  if (rows.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="shrink-0 font-medium text-faint">{kvKeyLabel(k)}</span>
          <span className="min-w-0 break-words font-mono text-muted">{clampStr(kvValueText(v), maxValueLen)}</span>
        </div>
      ))}
    </div>
  );
}

/** 输出块：JSON 自动美化（< 4KB），过长截断且可「展开全部」（L8/F4）。 */
function OutputBlock({ output, max = 1500 }: { output?: string | null; max?: number }) {
  if (!output) return null;
  let text = String(output);
  let language: string | null = null;
  if (text.length < 4000 && /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
      language = "json";
    } catch {
      /* 保持原文 */
    }
  }
  return <ExpandablePre text={text} max={max} language={language} />;
}

function extractImageGenerationPath(input: Input, output?: string | null): string {
  const direct = asStr(input?.savedPath) || asStr(input?.path) || asStr(input?.outputPath);
  if (direct) return direct;
  const text = asStr(output);
  if (!text) return "";
  const arrowMatch = /imageGeneration\s*→\s*(\S+)/.exec(text);
  if (arrowMatch) return arrowMatch[1];
  const imagePathMatch = /((?:\/[\w. -]+)+\.(?:png|jpe?g|webp|gif))/i.exec(text);
  return imagePathMatch?.[1] ?? "";
}

function stripDuplicateImageGenerationOutput(output: string | null | undefined, path: string): string | null {
  if (!output) return null;
  const text = String(output).trim();
  if (!text) return null;
  if (path && (text === path || text === `imageGeneration → ${path}`)) return null;
  return output;
}

// ── builtin ───────────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 60;
/** 全文模式的 diff 行数安全上限(渲染保护,不是产品截断)。 */
const MAX_DIFF_LINES_FULL = 4000;

/**
 * diff 截断行(T-12):一行里并排「展开全部（共 N 行）」与(有 inspect 回调时)「在详情面板查看全文」。
 * 此前是两行 —— 一行按钮 + 一行 `… (diff 过长，已截断)` 纯提示,语义重复叠在一起。
 */
function DiffTruncationRow({
  shown,
  total,
  onShowAll,
}: {
  shown: number;
  total: number;
  onShowAll?: () => void;
}) {
  const open = useContext(ToolInspectOpenContext);
  return (
    <div className="flex flex-wrap items-center gap-x-3 border-t border-border/60 px-3 py-1">
      <span className="text-faint">已显示前 {shown.toLocaleString()} 行</span>
      {onShowAll && (
        <InlineAction onClick={onShowAll}>展开全部（共 {total.toLocaleString()} 行）</InlineAction>
      )}
      {open && <InlineAction onClick={open}>在详情面板查看全文</InlineAction>}
    </div>
  );
}

/** diff 容器:窄屏 `whitespace-pre` + 横向滚动(与 Markdown 代码块一致,T-10),sm 以上保持折行;
 *  可横滑的容器要能聚焦,键盘用户才能滚(T-23)。 */
function DiffContainer({ children }: { children: ReactNode }) {
  return (
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 可横向滚动的容器必须能聚焦,键盘用户才能滚动(T-23)
      tabIndex={0}
      className="mt-1.5 overflow-x-auto rounded-md border border-border font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </div>
  );
}

const GUTTER_CLS =
  "w-9 shrink-0 select-none border-r border-border/60 pr-1.5 text-right text-[10.5px] leading-relaxed text-faint";

/** diff 单行:行号(旧/新)+ 符号 + 内容(可选 hljs 着色;hljs 输出已转义)。
 *  gutters:全新增/全删除 diff 隐藏恒空的那一列;窄屏只保留新行号列(T-10:390px 下 92px 固定 gutter
 *  把内容区挤到 ~230px)。 */
function DiffRowView({
  row,
  html,
  gutters,
}: {
  row: LineDiffRow;
  html: string | null;
  gutters: { old: boolean; new: boolean };
}) {
  return (
    <div
      className={cn(
        "flex w-max min-w-full sm:w-auto",
        row.sign === "-" ? "bg-danger-soft" : row.sign === "+" ? "bg-success-soft" : undefined,
      )}
    >
      {gutters.old && <span className={cn(GUTTER_CLS, gutters.new && "hidden sm:block")}>{row.oldNo ?? ""}</span>}
      {gutters.new && <span className={GUTTER_CLS}>{row.newNo ?? ""}</span>}
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          row.sign === "-" ? "text-danger" : row.sign === "+" ? "text-success" : "text-faint",
        )}
      >
        {row.sign === " " ? "" : row.sign}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre pr-3 sm:whitespace-pre-wrap sm:break-words",
          row.sign === "-" ? "text-danger" : row.sign === "+" ? "text-success" : "text-muted",
        )}
      >
        {html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: hljs 输出对源码已做 HTML 转义
          <span dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          row.text || " "
        )}
      </span>
    </div>
  );
}

/**
 * Edit 工具的行级 diff(F2):LCS 求未变行为上下文,只把真正变化的行标 +/-,
 * 带快照内行号;按文件后缀做 hljs 着色;超过行数上限时可「展开全部」。
 */
function DiffView({ oldStr, newStr, path }: { oldStr: string; newStr: string; path?: string }) {
  const full = useContext(ToolBodyFullContext);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr]);
  const maxLines = full || showAll ? MAX_DIFF_LINES_FULL : MAX_DIFF_LINES;
  const truncated = rows.length > maxLines;
  const highlight = useHighlighter(languageForPath(path ?? null));
  // 全新增(Write / 空 old_string)没有旧行号,全删除没有新行号:恒空的 gutter 不占位。
  const gutters = useMemo(
    () => ({
      old: rows.some((r) => r.oldNo !== null),
      new: rows.some((r) => r.newNo !== null),
    }),
    [rows],
  );
  return (
    <DiffContainer>
      {rows.slice(0, maxLines).map((r, i) => (
        <DiffRowView key={`${i}-${r.sign}`} row={r} html={highlight(r.text)} gutters={gutters} />
      ))}
      {truncated && (
        <DiffTruncationRow
          shown={maxLines}
          total={rows.length}
          onShowAll={showAll ? undefined : () => setShowAll(true)}
        />
      )}
    </DiffContainer>
  );
}

type TerminalSegment = { text: string; tone: "stdout" | "stderr" | "exit" };

/**
 * 单个"终端块":`$ 命令` + 输出合一渲染在同一个 pre 内(消除"命令一框 + 输出一框"的嵌套方框感)。
 *   - Cursor 信封 `{success:{stdout,stderr,exitCode}}` 先解包(T-03):stdout 正常、stderr 危险色、
 *     非 0 退出码末行「退出码 N」—— 不再把整段 JSON 当输出裸渲染;
 *   - 输出接 F4 展开原语(T-09):默认 2000 字 + 「展开全部 / 继续显示 / 收起」,不再是 320px 的
 *     嵌套滚动区(终端是最高频工具,却曾是唯一没有「展开全部」的体)。
 * 命令行不计入截断:审计用途下命令要完整可见(heredoc 写文件尤其如此)。
 */
function TerminalBlock({ command, output }: { command: string; output: string | null }) {
  const segments = useMemo<TerminalSegment[]>(() => {
    if (!output) return [];
    const env = parseShellEnvelope(output);
    if (!env) return [{ text: output, tone: "stdout" }];
    const segs: TerminalSegment[] = [];
    if (env.stdout) segs.push({ text: env.stdout, tone: "stdout" });
    if (env.stderr) {
      const needsBreak = env.stdout && !env.stdout.endsWith("\n");
      segs.push({ text: `${needsBreak ? "\n" : ""}${env.stderr}`, tone: "stderr" });
    }
    if (env.exitCode !== null && env.exitCode !== 0) {
      const last = segs[segs.length - 1];
      const needsBreak = last && !last.text.endsWith("\n");
      segs.push({ text: `${needsBreak ? "\n" : ""}退出码 ${env.exitCode}`, tone: "exit" });
    }
    return segs;
  }, [output]);
  const joined = useMemo(() => segments.map((s) => s.text).join(""), [segments]);
  const slice = useExpandableSlice(joined, 2000);
  // 把已显示的字符数按段切回去,stderr / 退出码保持各自的颜色。
  const nodes: ReactNode[] = [];
  let remaining = slice.shown.length;
  for (const seg of segments) {
    if (remaining <= 0) break;
    const part = seg.text.length > remaining ? seg.text.slice(0, remaining) : seg.text;
    remaining -= part.length;
    nodes.push(
      seg.tone === "stdout" ? (
        part
      ) : (
        <span key={`${seg.tone}-${nodes.length}`} className="text-danger">
          {part}
        </span>
      ),
    );
  }
  if (!command && nodes.length === 0) return null;
  return (
    <>
      <Pre>
        {command && (
          <>
            <span className="text-success">$ </span>
            {command}
            {nodes.length > 0 ? "\n" : ""}
          </>
        )}
        {nodes}
        {slice.truncated ? "\n…" : null}
      </Pre>
      <ExpandControls slice={slice} />
    </>
  );
}

function BashBody({ input, tool }: BodyProps) {
  const full = useContext(ToolBodyFullContext);
  // 展示层剥壳兜底:历史消息的 command 落库时可能带 /bin/bash -lc 包装(新帧已由
  // runner 剥好),先剥再进 oc 检测/写文件检测/展示。
  const rawCommand = stripShellWrapperForDisplay(asStr(input?.command));
  const command = rawCommand.slice(0, full ? FULL_TEXT_CAP : 2000);
  // oc-* 工具(文献检索/引用核验/…):若命令命中且输出可解析 → 渲染专门卡片,
  // 而非原始"$ 命令 + JSON"终端块。不认/出错 → 回落下方通用渲染。
  const ocCard = researchToolCard(command, tool);
  if (ocCard) return ocCard;
  const releaseCard = renderReleaseJobCard(command, tool);
  if (releaseCard) return releaseCard;
  const fileWrite = detectShellFileWrites(rawCommand);
  const out = tool.output;
  // bg-bash 的 tool_result.preview 只是占位文案（"Command running in background…"），
  // 不是真实输出；后台进程的真实 stdout/stderr 走 bashTail。识别占位 → 优先 bashTail。
  const isBgPlaceholder =
    typeof out === "string" &&
    (out.startsWith("Command running in background with ID:") ||
      out.startsWith("Command was manually backgrounded by user with ID:") ||
      out.includes("was moved to the background with ID:"));
  let outText: string | null = null;
  let headTruncated = false;
  let totalBytes = 0;
  if (out && !isBgPlaceholder) {
    outText = out;
  } else if (tool.bashTail && typeof tool.bashTail.tail === "string") {
    outText = tool.bashTail.tail;
    headTruncated = !!tool.bashTail.truncatedHead;
    totalBytes = tool.bashTail.totalBytes ?? 0;
  } else if (out) {
    outText = out;
  }
  if (!command && !outText) return null;
  const headNote = headTruncated ? (
    <FileMeta>输出过长，已省略开头部分（共 {totalBytes.toLocaleString()} 字节）</FileMeta>
  ) : null;
  if (fileWrite) {
    const status = tool.error
      ? "写入文件命令失败"
      : tool._completed
        ? `已写入 ${fileWrite.paths.length} 个文件`
        : "正在写入文件…";
    return (
      <>
        <StatusLine text={status} error={tool.error} tone={tool.error || tool._completed ? undefined : "muted"} />
        <div className={cn("mt-1.5 rounded-md px-3 py-2 text-xs", tool.error ? "bg-danger-soft" : "bg-success-soft")}>
          <div className={cn("font-medium", tool.error ? "text-danger" : "text-success")}>文件</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {fileWrite.paths.map((path) => (
              <li key={path} className="font-mono text-muted">
                {shortPath(path)}
              </li>
            ))}
          </ul>
        </div>
        {headNote}
        <FileMeta>原始终端命令</FileMeta>
        <TerminalBlock command={fileWrite.rawCommand} output={outText} />
      </>
    );
  }
  return (
    <>
      {headNote}
      <TerminalBlock command={command} output={outText} />
    </>
  );
}

// ── codex apply_patch(fileChange)形状 ──────────────────────────────────────
//
// codex 引擎的 Write/Edit 走 apply_patch,input 形如
// `{file_path, kind, changes:[{path, kind:{type:"add|update|delete"}, diff}]}`,
// **没有** claude 原生的 content/old_string/new_string —— 不特判就渲染成只剩一行
// output 文本的空壳卡。claude 原生形状不走这里,行为不变。

type CodexFileChange = { path: string; kind: string; diff: string };

/** 识别 codex fileChange 的 changes 数组;不是该形状 → null(调用方走原生渲染)。 */
function parseCodexFileChanges(input: Input): CodexFileChange[] | null {
  const rows = asArr(input?.changes).filter(
    (c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c),
  );
  if (rows.length === 0) return null;
  const fallbackKind = asStr(input?.kind);
  return rows.map((c) => {
    // change 级 kind 是 {type:"add"} 对象;顶层 kind 是字符串,作兜底。
    const kindRaw =
      c.kind && typeof c.kind === "object" && !Array.isArray(c.kind)
        ? asStr((c.kind as Record<string, unknown>).type)
        : asStr(c.kind);
    return {
      path: asStr(c.path) || asStr(input?.file_path),
      kind: (kindRaw || fallbackKind).toLowerCase(),
      diff: asStr(c.diff),
    };
  });
}

/** codex update 的 unified diff 按行着色(+绿 / -红 / 其余弱化),超上限可「展开全部」。 */
function UnifiedDiffView({ diff }: { diff: string }) {
  const full = useContext(ToolBodyFullContext);
  const [showAll, setShowAll] = useState(false);
  const maxLines = full || showAll ? MAX_DIFF_LINES_FULL : MAX_DIFF_LINES;
  const lines = diff.replace(/\n$/, "").split("\n");
  const truncated = lines.length > maxLines;
  return (
    <DiffContainer>
      {lines.slice(0, maxLines).map((line, i) => (
        <div
          key={`${i}-${line.slice(0, 24)}`}
          className={cn(
            "w-max min-w-full whitespace-pre px-3 py-px sm:w-auto sm:whitespace-pre-wrap sm:break-words",
            line.startsWith("+")
              ? "bg-success-soft text-success"
              : line.startsWith("-")
                ? "bg-danger-soft text-danger"
                : "text-muted",
          )}
        >
          {line || " "}
        </div>
      ))}
      {truncated && (
        <DiffTruncationRow
          shown={maxLines}
          total={lines.length}
          onShowAll={showAll ? undefined : () => setShowAll(true)}
        />
      )}
    </DiffContainer>
  );
}

/** add 分支的 diff 文本按「新文件内容」呈现:全部行都是 `+` 前缀时剥掉前缀(L2)。 */
function stripAddDiffPrefix(diff: string): string {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (!lines.some((l) => l.startsWith("+"))) return diff;
  if (!lines.every((l) => !l || l.startsWith("+"))) return diff;
  return lines.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n");
}

/** codex fileChange 渲染:add → 新文件内容;update → unified diff;delete → 删除状态行。
 *  多 changes 逐个显示 path。语义已结构化呈现,output("add: /path")只在失败时作错误说明。 */
function CodexFileChangesView({ changes, tool }: { changes: CodexFileChange[]; tool: ToolLike }) {
  return (
    <>
      {changes.map((c, i) => (
        <div key={`${i}-${c.path}`}>
          {c.path && <FileMeta>{shortPath(c.path)}</FileMeta>}
          {c.kind === "delete" ? (
            // 删除是成功执行的破坏性动作:danger 色明示,不能像编辑成功一样绿。
            <div className="mt-1.5 text-xs text-danger">删除文件</div>
          ) : c.kind === "update" ? (
            c.diff && <UnifiedDiffView diff={c.diff} />
          ) : (
            c.diff && (
              <>
                <div className="mt-1.5 text-xs text-success">新增文件</div>
                <ExpandablePre
                  text={stripAddDiffPrefix(c.diff)}
                  max={1500}
                  language={languageForPath(c.path)}
                />
              </>
            )
          )}
        </div>
      ))}
      {tool.error && tool.output && <StatusLine text={tool.output.slice(0, 300)} error />}
    </>
  );
}

function EditBody({ input, tool }: BodyProps) {
  const full = useContext(ToolBodyFullContext);
  const strCap = full ? FULL_TEXT_CAP : 3000;
  const oldStr = asStr(input?.old_string).slice(0, strCap);
  const newStr = asStr(input?.new_string).slice(0, strCap);
  // codex apply_patch 形状(无 old/new_string,changes 数组)→ 结构化渲染;claude 原生不变。
  if (!oldStr && !newStr) {
    const changes = parseCodexFileChanges(input);
    if (changes) return <CodexFileChangesView changes={changes} tool={tool} />;
  }
  const out = tool.output;
  return (
    <>
      {(oldStr || newStr) && (
        <DiffView oldStr={oldStr} newStr={newStr} path={asStr(input?.file_path)} />
      )}
      {out && <ResultStatusLine output={out} error={tool.error} max={tool.error ? 300 : 200} />}
    </>
  );
}

/** Edit/Write 的回执行:失败原样 danger;成功时已知英文回执映射中文,未知回执降为弱化色(T-27)。 */
function ResultStatusLine({ output, error, max }: { output: string; error?: boolean; max: number }) {
  if (error) return <StatusLine text={output.slice(0, max)} error />;
  const { text, known } = humanizeStatusOutput(output);
  return <StatusLine text={text.slice(0, max)} tone={known ? "success" : "muted"} />;
}

function ReadBody({ input, tool }: BodyProps) {
  const parts: string[] = [];
  // 「行 1, 70 行」语义含糊(T-30)→「从第 1 行起 · 读取 70 行」。
  if (input?.offset != null && input.offset !== "") parts.push(`从第 ${String(input.offset)} 行起`);
  if (input?.limit != null && input.limit !== "") parts.push(`读取 ${String(input.limit)} 行`);
  const out = tool.output;
  return (
    <>
      {parts.length > 0 && <FileMeta>{parts.join(" · ")}</FileMeta>}
      {out && <ExpandablePre text={out} max={2000} language={languageForPath(asStr(input?.file_path))} />}
    </>
  );
}

function WriteBody({ input, tool }: BodyProps) {
  const content = asStr(input?.content);
  // codex apply_patch 形状(无 content,changes 数组)→ 结构化渲染;claude 原生不变。
  if (!content) {
    const changes = parseCodexFileChanges(input);
    if (changes) return <CodexFileChangesView changes={changes} tool={tool} />;
  }
  const out = tool.output;
  return (
    <>
      {content && (
        <ExpandablePre text={content} max={500} language={languageForPath(asStr(input?.file_path))} />
      )}
      {out && <ResultStatusLine output={out} error={tool.error} max={200} />}
    </>
  );
}

/** 转义正则元字符,把字面 pattern 安全转为 RegExp 源。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Grep pattern → 命中高亮用 RegExp:先按原样试(ripgrep 语法大体兼容 JS),
 *  非法则按字面转义;仍失败 → null(不高亮)。 */
function grepPatternRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "gi");
  } catch {
    try {
      return new RegExp(escapeRegExp(pattern), "gi");
    } catch {
      return null;
    }
  }
}

/** 单行文本按 regex 命中包 <mark>(React 节点拼接,非 innerHTML,天然防注入)。 */
function markLine(line: string, re: RegExp): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0] === "") {
      // 零宽匹配(如 `a*`)不高亮且必须手动推进,防死循环。
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(
      <mark key={`${m.index}-${parts.length}`} className="rounded-sm bg-warning-soft px-0.5 text-fg">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return line;
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

/** Grep 内容输出:按 pattern 高亮命中(M2),截断可展开(F4)。 */
function GrepOutput({ text, pattern }: { text: string; pattern: string }) {
  const slice = useExpandableSlice(text, 2000);
  const re = useMemo(() => grepPatternRegex(pattern), [pattern]);
  return (
    <>
      <pre className={PRE_CLS}>
        {re
          ? slice.shown.split("\n").map((line, i) => (
              <span key={`${i}-${line.slice(0, 16)}`}>
                {i > 0 ? "\n" : null}
                {markLine(line, re)}
              </span>
            ))
          : slice.shown}
        {slice.truncated ? "\n…" : null}
      </pre>
      <ExpandControls slice={slice} />
    </>
  );
}

/** 逐行路径输出 → 文件列表(Grep files_with_matches 与 Glob 同款,T-31)。 */
function FileList({ text }: { text: string }) {
  const [showAll, setShowAll] = useState(false);
  const files = Array.from(
    new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  );
  if (files.length === 0) return null;
  const limit = showAll ? files.length : 30;
  return (
    <div className="mt-1.5">
      <ul className="flex flex-col gap-0.5">
        {files.slice(0, limit).map((f) => (
          <li key={f} className="flex items-center gap-1.5 font-mono text-xs text-muted">
            <FileText size={12} className="shrink-0 text-faint" aria-hidden="true" />
            <span className="min-w-0 break-all">{shortPath(f)}</span>
          </li>
        ))}
      </ul>
      {files.length > limit && (
        <InlineAction className="mt-1" onClick={() => setShowAll(true)}>
          展开全部（共 {files.length.toLocaleString()} 个文件）
        </InlineAction>
      )}
    </div>
  );
}

function GrepBody({ input, tool }: BodyProps) {
  const parts: string[] = [];
  if (input?.path) parts.push(shortPath(input.path));
  if (input?.glob) parts.push(`文件匹配 ${asStr(input.glob)}`);
  const mode = asStr(input?.output_mode);
  if (mode) parts.push(OUTPUT_MODE_LABELS[mode] ?? mode.replace(/_/g, " "));
  const out = tool.output;
  const filesMode = mode === "files_with_matches";
  return (
    <>
      {parts.length > 0 && <FileMeta>{parts.join(" · ")}</FileMeta>}
      {out &&
        (filesMode ? (
          <FileList text={out} />
        ) : (
          <GrepOutput text={out} pattern={asStr(input?.pattern)} />
        ))}
    </>
  );
}

/** Glob 输出是逐行路径:与 Grep 文件列表同一呈现(T-31),不再是一坨等宽全路径文本。 */
function GlobBody({ input, tool }: BodyProps) {
  const out = tool.output;
  // 每一行都像路径(含分隔符或扩展名)才按文件列表呈现;"No files found" 这类提示保持文本块。
  const isPathList =
    !!out &&
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .every((l) => /[\\/]|\.\w+$/.test(l));
  return (
    <>
      {input?.path && <FileMeta>{shortPath(input.path)}</FileMeta>}
      {out && (isPathList ? <FileList text={out} /> : <ExpandablePre text={out} max={2000} />)}
    </>
  );
}

function TodoWriteBody({ input, tool }: BodyProps) {
  const todos = asArr(input?.todos).filter(
    (t): t is Record<string, unknown> => !!t && typeof t === "object",
  );
  if (todos.length === 0) return <OutputBlock output={tool.output} />;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {todos.map((t, i) => {
        const status = asStr(t.status) || "pending";
        const mark = status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
        const text = status === "in_progress" && t.activeForm ? asStr(t.activeForm) : asStr(t.content);
        return (
          <div key={i} className="flex items-start gap-2 text-body">
            <span
              className={cn(
                "mt-px shrink-0",
                status === "completed" ? "text-success" : status === "in_progress" ? "text-accent" : "text-faint",
              )}
            >
              {mark}
            </span>
            <span className={cn("min-w-0 break-words", status === "completed" ? "text-faint line-through" : "text-fg")}>
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function WebFetchBody({ input, tool }: BodyProps) {
  return (
    <>
      {input && <KvList obj={{ url: input.url, prompt: input.prompt }} />}
      <OutputBlock output={tool.output} />
    </>
  );
}

function WebSearchBody({ input, tool }: BodyProps) {
  // 富卡:把结果文本解析成来源列表;解析不出(空/畸形/出错)→ 回落通用 OutputBlock(UX 铁律)。
  const card = tool.error ? null : WebSearchResultsCard({ tool });
  return (
    <>
      {input && (
        <KvList
          obj={{
            query: input.query,
            results: input.results,
            allowed_domains: input.allowed_domains,
            blocked_domains: input.blocked_domains,
          }}
        />
      )}
      {card ?? <OutputBlock output={tool.output} />}
    </>
  );
}

// ── MCP ─────────────────────────────────────────────────────────────────────

function BrowserBody({ op, input, tool }: BodyProps & { op: string }) {
  let head: ReactNode = null;
  if (op === "browser_navigate" && asStr(input?.url)) {
    const url = asStr(input?.url);
    head = isSafeHttpUrl(url) ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block break-all rounded-lg bg-info-soft px-3 py-2.5 text-meta font-medium text-info outline-none transition-colors hover:bg-info-soft/80 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {url}
      </a>
    ) : (
      <div className="block break-all rounded-lg bg-hover px-3 py-2.5 text-xs text-muted">
        {url}
      </div>
    );
  } else if (op === "browser_evaluate" || op === "browser_run_code") {
    const code = asStr(input?.code) || asStr(input?.function);
    if (code) head = <ExpandablePre text={code} max={1500} language="javascript" />;
  } else if (input) {
    const target = asStr(input.element) || asStr(input.ref);
    const text = asStr(input.text);
    const key = asStr(input.key);
    const option = asStr(input.values) || asStr(input.value);
    const useful = [
      target ? { label: "目标", value: target } : null,
      text ? { label: op === "browser_wait_for" ? "等待内容" : "文本", value: text } : null,
      key ? { label: "按键", value: key } : null,
      option ? { label: "选项", value: option } : null,
    ].filter((row): row is { label: string; value: string } => !!row);
    head = useful.length > 0 ? (
      <dl className="grid gap-2 sm:grid-cols-2">
        {useful.map((row) => (
          <div key={row.label} className="min-w-0 rounded-lg bg-hover/70 px-3 py-2">
            <dt className="text-caption font-medium text-faint">{row.label}</dt>
            <dd className="mt-0.5 break-words text-meta text-fg">{row.value}</dd>
          </div>
        ))}
      </dl>
    ) : <KvList obj={input} skip={["_meta"]} />;
  }
  const screenshotPath = op === "browser_take_screenshot"
    ? asStr(input?.filename) || asStr(input?.path) || /(?:\/[^\s"']+\.(?:png|jpe?g|webp))/i.exec(asStr(tool.output))?.[1] || ""
    : "";
  const safeScreenshot = screenshotPath ? safeArtifactSrc(screenshotPath) : null;
  return (
    <>
      {head}
      {safeScreenshot && (
        <div className="mt-2.5 overflow-hidden rounded-lg bg-code p-2">
          <SignedImg src={safeScreenshot} alt="页面截图" className="max-h-64 rounded-md object-contain" />
        </div>
      )}
      {!safeScreenshot && <OutputBlock output={tool.output} />}
    </>
  );
}

function MediaBody({ input, tool }: BodyProps) {
  let prompt = "";
  if (input) {
    for (const k of ["prompt", "text", "lyrics", "first_frame_image", "last_frame_image", "subject_reference"]) {
      const v = input[k];
      if (typeof v === "string" && v) {
        prompt = v;
        break;
      }
    }
  }
  return (
    <>
      {prompt && <PromptBlock>{prompt}</PromptBlock>}
      {input && <KvList obj={input} skip={["prompt", "text", "lyrics", "output_directory"]} />}
      <OutputBlock output={tool.output} />
    </>
  );
}

function VisionBody({ input, tool }: BodyProps) {
  const prompt = asStr(input?.prompt) || asStr(input?.question) || asStr(input?.query);
  return (
    <>
      {prompt && <PromptBlock>{prompt}</PromptBlock>}
      {input && <KvList obj={input} skip={["prompt", "question", "query"]} />}
      <OutputBlock output={tool.output} />
    </>
  );
}

function CodexBody({ type, input, tool }: BodyProps & { type: string }) {
  if (type === "imageView") {
    const target = asStr(input?.path) || asStr(input?.url);
    // 缩略图(样式对齐 BrowserCliCard 截图);safeArtifactSrc 白名单防恶意 scheme,
    // 加载失败/文件已删走 SignedImg 既有占位 chip(alt 文本),不出现裂图。
    const safeImg = safeArtifactSrc(target);
    return (
      <>
        {safeImg && (
          <div className="mt-1.5">
            {/* 最小显示尺寸 + object-contain + 底色:1×1/极小像素图不再被渲染成隐形小点。 */}
            <SignedImg
              src={safeImg}
              alt="查看的图片"
              className="max-h-56 min-h-16 min-w-16 rounded-md border border-border bg-code object-contain"
            />
          </div>
        )}
        {target && <FileMeta>{shortPath(target)}</FileMeta>}
        <OutputBlock output={tool.output} />
      </>
    );
  }
  if (type === "subAgentActivity") {
    // 子代理生命周期事件:语义状态行即全部信息。agentThreadId 是内部 id 无用户价值,
    // 不显示;也绝不落 OutputBlock 裸 JSON。kind 全映射中文(未知 kind 也不外露英文原词)。
    const kind = asStr(input?.kind);
    const status =
      kind === "started"
        ? "已启动"
        : kind === "interacted"
          ? "协作中"
          : kind === "completed" || kind === "finished"
            ? "已完成"
            : kind === "failed"
              ? "失败"
              : "子代理活动";
    const agentPath = asStr(input?.agentPath);
    return (
      <>
        <StatusLine text={status} error={kind === "failed"} />
        <div className="mt-1 text-xs text-faint">模型开启的后台协作线程,用于并行处理子任务。</div>
        {agentPath && <FileMeta>{shortPath(agentPath)}</FileMeta>}
      </>
    );
  }
  if (type === "imageGeneration") {
    const prompt = asStr(input?.prompt) || asStr(input?.revisedPrompt);
    const savedPath = extractImageGenerationPath(input, tool.output);
    // status==='failed'(或引擎标 error)是明确失败终态:显式「生成失败」danger 行,
    // 绝不落到「图片已生成」歧义;原因文本(若有)由下方 OutputBlock 呈现。
    const failed = /^(failed|error)$/i.test(asStr(input?.status)) || !!tool.error;
    const running = !tool._completed && !tool.error && !failed;
    const output = stripDuplicateImageGenerationOutput(tool.output, savedPath);
    return (
      <>
        {prompt && <PromptBlock>{prompt}</PromptBlock>}
        {running && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            <Spinner size={12} className="text-accent" />
            <span>图片生成中，通常需要几十秒，请稍候…</span>
          </div>
        )}
        {failed && <StatusLine text="生成失败" error />}
        {!running && !failed && <StatusLine text="图片已生成" />}
        {savedPath && !failed && <FileMeta>{shortPath(savedPath)}</FileMeta>}
        {input && (
          <KvList
            obj={input}
            skip={[
              "id",
              "type",
              "status",
              "prompt",
              "revisedPrompt",
              "result",
              "savedPath",
              "path",
              "outputPath",
              "durationMs",
              "pluginId",
              "_meta",
            ]}
          />
        )}
        <OutputBlock output={output} />
      </>
    );
  }
  if (type === "contextCompaction") {
    return (
      <>
        <KvList
          obj={{
            "tokens before": input?.tokensBefore ?? input?.beforeTokens,
            "tokens after": input?.tokensAfter ?? input?.afterTokens,
            note: input?.note || input?.summary,
          }}
        />
        <OutputBlock output={tool.output} />
      </>
    );
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return (
      <>
        <StatusLine text={type === "enteredReviewMode" ? "已进入审阅模式" : "已退出审阅模式"} />
        {(input?.note || input?.summary) && <PromptBlock>{asStr(input?.note) || asStr(input?.summary)}</PromptBlock>}
        <OutputBlock output={tool.output} />
      </>
    );
  }
  return (
    <>
      {input && (
        <KvList
          obj={input}
          // codex 事件的传输噪音字段全 skip(appContext/error 也是:error 文本已由
          // extractCodexOutput 提进 output,KvList 再显示一遍只会是 JSON 噪音)。
          skip={[
            "id",
            "type",
            "pluginId",
            "result",
            "structuredContent",
            "_meta",
            "status",
            "durationMs",
            "appContext",
            "error",
          ]}
        />
      )}
      <OutputBlock output={tool.output} />
    </>
  );
}

/** skill_save / skill_propose 的富卡:技能创建流程的核心动作,按技能卡样式呈现
 *(名称/描述/标签/正文折叠),让「对话中创建技能」所见即所得,而非一坨 KV。 */
function SkillWriteCard({ op, input, tool }: BodyProps & { op: string }) {
  const name = typeof input?.name === "string" ? input.name : "";
  const description = typeof input?.description === "string" ? input.description : "";
  const tags = Array.isArray(input?.tags) ? (input?.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  const body = typeof input?.body === "string" ? input.body : "";
  const rationale = typeof input?.rationale === "string" ? input.rationale : "";
  const done = !!tool._completed && !tool.error;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-elevated p-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-mono text-body font-semibold text-fg">{name || "(未命名)"}</span>
            <Badge tone="accent">{op === "skill_propose" ? "训练草稿" : "技能"}</Badge>
            {done && <Badge tone="success">{op === "skill_propose" ? "已暂存" : "已保存"}</Badge>}
          </div>
          {description && <p className="mt-0.5 text-[12px] leading-snug text-muted">{description}</p>}
          {tags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {tags.slice(0, 6).map((t) => (
                <Badge key={t} tone="neutral">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          {rationale && <p className="mt-1 text-caption text-faint">理由:{rationale}</p>}
        </div>
      </div>
      {body && (
        <details>
          <summary className={INLINE_SUMMARY_CLS}>查看技能正文</summary>
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: 有 max-h 的滚动区要能聚焦,键盘才能滚(T-23)
            tabIndex={0}
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </pre>
        </details>
      )}
      <OutputBlock output={tool.output} />
    </div>
  );
}

function parseJsonObjectSafe(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function MemoryBody({ op, input, tool }: BodyProps & { op: string }) {
  const actions = useToolCardActions();
  if (op === "skill_save" || op === "skill_propose") {
    return (
      <>
        <SkillWriteCard op={op} input={input} tool={tool} />
        {actions.onOpenSkills && (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={actions.onOpenSkills}>
              打开技能库
            </Button>
          </div>
        )}
      </>
    );
  }

  const btns: ReactNode[] = [];
  // 注:核心记忆 `memory` op 已退役(改 memdir 文件写入);深层召回(archival/session_search)仍导向记忆中心。
  if (["archival_add", "archival_search", "session_search"].includes(op) && actions.onOpenMemory) {
    btns.push(
      <Button key="mem" variant="ghost" size="sm" onClick={actions.onOpenMemory}>
        打开记忆中心
      </Button>,
    );
  }
  if (["skill_list", "skill_view", "skill_save", "skill_delete", "skill_search"].includes(op) && actions.onOpenSkills) {
    btns.push(
      <Button key="sk" variant="ghost" size="sm" onClick={actions.onOpenSkills}>
        打开技能库
      </Button>,
    );
  }
  if (["create_reminder", "list_reminders", "update_reminder", "delete_reminder"].includes(op) && actions.onOpenTasks) {
    btns.push(
      <Button key="tk" variant="ghost" size="sm" onClick={actions.onOpenTasks}>
        查看定时任务
      </Button>,
    );
  }

  // 富卡自带输出信息(列表/结果已结构化呈现)→ 命中时抑制默认 OutputBlock,避免卡片
  // 下再挂一坨重复文本;富卡解析失败(card=null)时保留 OutputBlock 兜底(UX 铁律)。
  let body: ReactNode = null;
  let suppressOutput = false;
  if (op === "list_reminders") {
    body = renderReminderListCard(tool.output) ?? <OutputBlock output={tool.output} />;
    suppressOutput = true;
  } else if (["create_reminder", "update_reminder", "delete_reminder"].includes(op)) {
    body = <ReminderStatusCard op={op} input={input} output={tool.output} error={!!tool.error} />;
    suppressOutput = true;
  } else if (op === "skill_list") {
    const card = renderSkillListCard(tool.output);
    body = card ?? <KvList obj={input} />;
    suppressOutput = !!card;
  } else if (op === "skill_search") {
    const card = renderSkillSearchCard(tool.output, asStr(input?.query));
    body = card ?? <KvList obj={input} />;
    suppressOutput = !!card;
  } else if (op === "skill_view") {
    const card = renderSkillViewCard(tool.output);
    body = card ?? <KvList obj={input} />;
    suppressOutput = !!card;
  } else if (op === "delegate_tasks") {
    const card = renderDelegateFanoutCard(tool.output);
    body = card ?? <KvList obj={input} />;
    suppressOutput = !!card;
  } else if (op === "delegate_task" || op === "send_to_agent") {
    const title =
      safeSubtaskDescription({ description: asStr(input?.goal) || asStr(input?.message) }) || "运行子任务";
    body = <div className="mt-1.5 text-xs text-muted">{title}</div>;
  } else if (op === "present_task_approval") {
    const ticketId = asStr(input?.id) || asStr(input?.identifier);
    if (ticketId && !tool.error) {
      body = (
        <Suspense fallback={<div className="mt-1.5 text-caption text-faint">加载审批卡…</div>}>
          <TaskApprovalCard id={ticketId} prompt={asStr(input?.prompt) || undefined} />
        </Suspense>
      );
      suppressOutput = true;
    } else {
      body = <KvList obj={input} />;
    }
  } else if (op === "consult_advisor") {
    const parsed = parseJsonObjectSafe(tool.outputJson ?? tool.output);
    const advice = asStr(parsed?.advice) || asStr(parsed?.result) || "";
    const model = asStr(parsed?.model) || asStr(parsed?.advisorModel) || asStr(input?.model);
    const status = asStr(parsed?.status);
    const err = asStr(parsed?.error);
    const duration =
      typeof parsed?.durationMs === "number"
        ? parsed.durationMs
        : typeof tool.durationMs === "number"
          ? tool.durationMs
          : null;
    const usage = parsed?.usage;
    // 合并取舍(发布预演 t-1279):整块取 canonical OCV5-220 —— 进行中 / 已结束两态、人话时长、
    // 状态词经 advisorConsultStatusLabel 人话化(审计 T-27 的诉求由它兑现;timeout → 超时补进该函数)。
    const question = asStr(input?.question);
    const concern = asStr(input?.concern);
    const running = isToolInFlight(tool);
    const statusLabel = running ? "" : advisorConsultStatusLabel(status);
    const durationLabel = formatToolDuration(duration);
    const doneBits = [
      model ? `顾问 ${model}` : null,
      statusLabel || null,
      durationLabel,
    ].filter(Boolean);
    body = (
      <div className="mt-1.5 space-y-1.5 text-xs leading-relaxed text-fg">
        {question ? (
          <div>
            <div className="text-faint">问了什么</div>
            <div className="whitespace-pre-wrap text-fg">{question}</div>
          </div>
        ) : null}
        {concern ? <div className="text-muted">关注点：{concern}</div> : null}
        <div className="text-muted">
          {running
            ? `顾问思考中${durationLabel ? ` · 已用时 ${durationLabel}` : ""}`
            : doneBits.length > 0
              ? doneBits.join(" · ")
              : "顾问已结束"}
        </div>
        {err ? <div className="text-danger">{err}</div> : null}
        {advice ? <PromptBlock>{advice}</PromptBlock> : null}
        {!running && usage == null ? (
          <div className="text-faint">顾问用量未返回，主/顾问分项以账户用量明细为准。</div>
        ) : !running && usage != null ? (
          <KvList obj={typeof usage === "object" && usage ? (usage as Record<string, unknown>) : { usage }} />
        ) : null}
      </div>
    );
    suppressOutput = running || !!advice || !!status || !!err;
  } else {
    body = <KvList obj={input} />;
  }

  return (
    <>
      {body}
      {!suppressOutput && <OutputBlock output={tool.output} />}
      {btns.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{btns}</div>}
    </>
  );
}

// ── scansci-pdf（论文卡）──────────────────────────────────────────────────
const SCANSCI_SENSITIVE_OPS = new Set(["scansci_pdf_config_get", "scansci_pdf_config_set"]);

function parseToolJson(output?: string | null): Record<string, unknown> | null {
  if (!output) return null;
  const text = String(output).trim();
  if (!text || !/^[[{]/.test(text)) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findPdfPath(v: unknown): string {
  if (typeof v === "string") {
    const m = v.match(/\/[^\s"'<>]+\.pdf\b/i);
    return m ? m[0] : "";
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = findPdfPath(x);
      if (p) return p;
    }
    return "";
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const key of ["file", "pdf", "pdf_path", "path", "output_file"]) {
      const p = findPdfPath(obj[key]);
      if (p) return p;
    }
    for (const value of Object.values(obj)) {
      const p = findPdfPath(value);
      if (p) return p;
    }
  }
  return "";
}

function scanSciIdentifier(r: Record<string, unknown>): string {
  const val = r.doi || r.arxiv || r.arxiv_id || r.identifier || r.url || r.title || r.display_name;
  return typeof val === "string" ? val.trim().slice(0, 320) : "";
}

function ScanSciResults({
  results,
  onPaper,
}: {
  results: Record<string, unknown>[];
  onPaper?: (action: "download" | "citation", identifier: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {results.map((r, i) => {
        const identifier = scanSciIdentifier(r);
        const authors = Array.isArray(r.authors) ? r.authors.slice(0, 3).join(", ") : asStr(r.authors);
        const parts = [r.year || r.publication_year, authors, r.doi || r.arxiv || r.arxiv_id, r.source]
          .filter(Boolean)
          .map(String);
        return (
          <div key={i} className="rounded-md border border-border bg-surface px-3 py-2">
            <div className="break-words text-body font-medium text-fg">
              {asStr(r.title) || asStr(r.display_name) || asStr(r.identifier) || asStr(r.doi) || "无标题论文"}
            </div>
            {parts.length > 0 && <div className="mt-0.5 text-xs text-faint">{parts.join(" · ")}</div>}
            {onPaper && identifier && (
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => onPaper("download", identifier)}>
                  下载 PDF
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onPaper("citation", identifier)}>
                  生成引用
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScanSciChecks({ checks }: { checks: Record<string, unknown> }) {
  const entries = Object.entries(checks).slice(0, 12);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {entries.map(([name, info]) => {
        const status = info && typeof info === "object" ? (info as Record<string, unknown>).status : info;
        const ok = status === "ok";
        return (
          <span
            key={name}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
              ok ? "bg-success-soft text-success" : "bg-warning-soft text-warning",
            )}
          >
            <span className="text-faint">{name}</span>
            <strong>{status ? String(status) : "—"}</strong>
          </span>
        );
      })}
    </div>
  );
}

function PdfChip({ path }: { path: string }) {
  return (
    <div className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-border bg-hover px-3 py-2 text-xs text-fg">
      <FileText size={14} className="text-accent" />
      <span className="break-all">{shortPath(path)}</span>
    </div>
  );
}

function ScanSciBody({ op, input, tool }: BodyProps & { op: string }) {
  const actions = useToolCardActions();
  if (SCANSCI_SENSITIVE_OPS.has(op)) {
    return <StatusLine text="配置类工具已执行；为保护机构登录、代理、Cookie 或 Token 等敏感信息，参数与输出已隐藏。" />;
  }
  const promptVal = asStr(input?.identifier) || asStr(input?.query) || asStr(input?.file_path);
  const head = (
    <>
      {promptVal && <PromptBlock>{promptVal}</PromptBlock>}
      {input && <KvList obj={input} skip={["identifier", "query", "file_path"]} />}
    </>
  );

  const data = parseToolJson(tool.output);
  if (!data) {
    return (
      <>
        {head}
        <OutputBlock output={tool.output} />
      </>
    );
  }

  const rawResults = data.results ?? data.items;
  const results = Array.isArray(rawResults)
    ? rawResults.filter((r): r is Record<string, unknown> => !!r && typeof r === "object").slice(0, 8)
    : [];
  if (results.length > 0 && op === "scansci_pdf_search") {
    return (
      <>
        {head}
        <ScanSciResults results={results} onPaper={actions.onPaperAction} />
      </>
    );
  }

  const statusText =
    data.success === true
      ? "完成"
      : data.success === false
        ? asStr(data.error) || "失败"
        : asStr(data.overall) || asStr(data.status);
  const pdfPath = findPdfPath(data);
  const citation = asStr(data.citation);
  const checks = data.checks && typeof data.checks === "object" ? (data.checks as Record<string, unknown>) : null;

  return (
    <>
      {head}
      {results.length > 0 && <ScanSciResults results={results} onPaper={actions.onPaperAction} />}
      {statusText && <StatusLine text={statusText.slice(0, 200)} error={data.success === false} />}
      {pdfPath && <PdfChip path={pdfPath} />}
      {citation && <Pre>{citation.slice(0, 2000)}</Pre>}
      {checks ? (
        <ScanSciChecks checks={checks} />
      ) : (
        <>
          <KvList
            obj={{
              title: data.title,
              doi: data.doi,
              source: data.source,
              file: data.file || data.pdf_path || data.path,
              strategy: data.strategy,
              batch: data.batch_id,
            }}
          />
          {!pdfPath && !citation && <OutputBlock output={tool.output} max={900} />}
        </>
      )}
    </>
  );
}

function shortBackgroundTaskId(input: Input): string {
  const ids = input && Array.isArray(input.task_ids) ? input.task_ids : [];
  const first =
    (typeof ids[0] === "string" && ids[0]) ||
    (typeof input?.task_id === "string" && input.task_id) ||
    (typeof input?.task_id === "number" && Number.isFinite(input.task_id) ? String(input.task_id) : "");
  if (!first) return "";
  return first.length > 16 ? `${first.slice(0, 16)}…` : first;
}

function TaskBody({ input, tool, name }: BodyProps & { name?: string }) {
  const desc = safeSubtaskDescription(input);
  // 后台命令的内部 call-id 对用户没有价值(T-27),只标「等待后台命令」。
  const waiting = name === "TaskOutput" || !!shortBackgroundTaskId(input);
  const title = desc || (waiting ? "等待后台命令" : "运行子任务");
  // 有输出时表头摘要已经是同一句 description,展开体不再重复一遍(T-20);无输出才用标题占位。
  const hasOutput = typeof tool.output === "string" && tool.output.trim().length > 0;
  return (
    <>
      {(!hasOutput || !desc) && <div className="mt-1.5 text-xs text-muted">{title}</div>}
      <OutputBlock output={tool.output} />
    </>
  );
}

/** 工具名短显示:mcp__server__op → server: op;其它原样。 */
function shortToolName(name: string): string {
  const mcp = parseMcpName(name);
  return mcp ? `${mcp.server}: ${mcp.op}` : name;
}

/**
 * CCB `SearchExtraTools {query}`:查找延迟工具。结果文本 "Found N deferred tool(s): a, b.\nUse
 * ExecuteExtraTool …" 只展示找到的工具名列表,不回显给模型看的使用提示。
 */
function SearchExtraToolsBody({ input, tool }: BodyProps) {
  const query = searchExtraToolsQuery(input);
  const parsed = parseSearchExtraToolsResult(tool.output);
  return (
    <>
      {query && (
        <div className="mt-1.5 text-xs text-muted">
          查找 <span className="font-mono text-fg">{clampStr(query, 120)}</span>
        </div>
      )}
      {parsed ? (
        parsed.none ? (
          <FileMeta>未找到匹配的工具</FileMeta>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {parsed.found.map((name) => (
              <Badge key={name} tone="neutral" className="font-mono">
                {shortToolName(name)}
              </Badge>
            ))}
          </div>
        )
      ) : (
        <OutputBlock output={tool.output} />
      )}
    </>
  );
}

function GenericBody({ name, input, tool }: BodyProps & { name: string }) {
  const mapped = mappedLiveActivityLabel(name);
  const hideArgs = !!mapped || isOpaqueArgToolName(name) || isInternalSubtaskInput(input);
  const isSubtask = isInternalSubtaskInput(input) || /^(task|agent)$/i.test(name);
  const summary = isSubtask
    ? safeSubtaskDescription(input) || "运行子任务"
    : mapped || formatLiveActivityAction(name) || "执行操作";
  return (
    <>
      {hideArgs ? (
        <div className="mt-1.5 text-xs text-muted">{summary}</div>
      ) : (
        input && typeof input === "object" && <KvList obj={input} />
      )}
      <OutputBlock output={tool.output} />
    </>
  );
}

/**
 * 工具体二级分派：先按 builtin 名，再按 `mcp__<server>__<op>` 的 server，兜底 generic。
 * 端口自 `_renderToolBody`（去 codex 分支）。
 */
export function ToolBody({ name, input, tool }: { name: string; input: Input; tool: ToolLike }) {
  switch (name) {
    case "Bash":
      return <BashBody input={input} tool={tool} />;
    case "Edit":
      return <EditBody input={input} tool={tool} />;
    case "Read":
      return <ReadBody input={input} tool={tool} />;
    case "Write":
      return <WriteBody input={input} tool={tool} />;
    case "Grep":
      return <GrepBody input={input} tool={tool} />;
    case "Glob":
      return <GlobBody input={input} tool={tool} />;
    case "TodoWrite":
      return <TodoWriteBody input={input} tool={tool} />;
    case "WebFetch":
      return <WebFetchBody input={input} tool={tool} />;
    case "WebSearch":
      return <WebSearchBody input={input} tool={tool} />;
    case "SearchExtraTools":
      return <SearchExtraToolsBody input={input} tool={tool} />;
    case "Task":
    case "Agent":
    case "TaskOutput":
    case "TaskStop":
      return <TaskBody name={name} input={input} tool={tool} />;
  }
  const codexType = parseCodexTypeName(name);
  if (codexType) return <CodexBody type={codexType} input={input} tool={tool} />;
  const mcp = parseMcpName(name);
  if (mcp) {
    if (mcp.server === "browser") return <BrowserBody op={mcp.op} input={input} tool={tool} />;
    if (mcp.server === "minimax-media") return <MediaBody input={input} tool={tool} />;
    if (mcp.server === "minimax-vision" || mcp.server === "openclaude-vision")
      return <VisionBody input={input} tool={tool} />;
    if (mcp.server === "openclaude-memory") return <MemoryBody op={mcp.op} input={input} tool={tool} />;
    if (mcp.server === "scansci-pdf") return <ScanSciBody op={mcp.op} input={input} tool={tool} />;
    if (mcp.server === "codex") {
      // codex 内建 MCP 资源清单;非资源类 op 或解析失败回落通用体。
      const card = renderMcpResourcesCard(tool.output);
      if (card) return card;
    }
  }
  return <GenericBody name={name} input={input} tool={tool} />;
}
