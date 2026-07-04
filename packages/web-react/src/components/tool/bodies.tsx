/**
 * 工具卡**展开体**的二级渲染器（Aurora 视觉，功能 parity 现网
 * `_renderToolBody` 及各 `_render*`）。每个 body 接收已解析的 input 与 tool 对象。
 *
 * 含 v3/Codex 历史 item 的紧凑渲染；Codex MCP/dynamic wrapper 大多已在
 * format 层归一化为 native builtin/MCP 工具。
 */
import { Sparkles, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Badge, Button } from "../ui";
import { useToolCardActions } from "./context";
import {
  asArr,
  asStr,
  clampStr,
  detectShellFileWrites,
  formatValue,
  isSafeHttpUrl,
  parseCodexTypeName,
  shortPath,
  type ToolLike,
} from "./format";
import { parseMcpName } from "./meta";
import { researchToolCard } from "./researchCards";

type Input = Record<string, unknown> | null;
type BodyProps = { input: Input; tool: ToolLike };

// ── 共用原语 ──────────────────────────────────────────────────────────────

/**
 * 等宽预格式化块（终端输出 / 文件内容 / 代码）。
 * 无边框——卡壳本身（ToolCard 的 border-t 体区）已是容器，再加边框会变"框中框"（设计 `.out` 即无边框）。
 * 仅用 bg-code 这层极淡表面做区隔。
 */
function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-relaxed text-fg",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function FileMeta({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 text-xs text-faint">{children}</div>;
}

function StatusLine({ text, error }: { text: string; error?: boolean }) {
  if (!text) return null;
  return <div className={cn("mt-1.5 text-xs", error ? "text-danger" : "text-success")}>{text}</div>;
}

function PromptBlock({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-hover px-3 py-2 text-[13px] text-fg">
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
          <span className="shrink-0 font-medium text-faint">{k}</span>
          <span className="min-w-0 break-words font-mono text-muted">{clampStr(formatValue(v), maxValueLen)}</span>
        </div>
      ))}
    </div>
  );
}

/** 输出块：JSON 自动美化（< 4KB），过长夹断。 */
function OutputBlock({ output, max = 1500 }: { output?: string | null; max?: number }) {
  if (!output) return null;
  let text = String(output);
  if (text.length < 4000 && /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* 保持原文 */
    }
  }
  return <Pre>{text.length > max ? text.slice(0, max) + "\n…" : text}</Pre>;
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

/** Edit 工具的加减行 diff。oldStr → 删除行（红），newStr → 新增行（绿）。 */
function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const rows: { sign: "-" | "+"; text: string }[] = [];
  let truncated = false;
  const add = (sign: "-" | "+", str: string) => {
    if (!str) return;
    for (const line of str.split("\n")) {
      if (rows.length >= MAX_DIFF_LINES) {
        truncated = true;
        return;
      }
      rows.push({ sign, text: line });
    }
  };
  add("-", oldStr);
  if (!truncated) add("+", newStr);
  return (
    <div className="mt-1.5 overflow-x-auto rounded-md border border-border font-mono text-xs leading-relaxed">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre-wrap break-words px-3 py-px",
            r.sign === "-" ? "bg-danger-soft text-danger" : "bg-success-soft text-success",
          )}
        >
          {r.sign} {r.text}
        </div>
      ))}
      {truncated && <div className="px-3 py-1 text-faint">… (diff 过长，已截断)</div>}
    </div>
  );
}

function BashBody({ input, tool }: BodyProps) {
  const rawCommand = asStr(input?.command);
  const command = rawCommand.slice(0, 2000);
  // oc-* 工具(文献检索/引用核验/…):若命令命中且输出可解析 → 渲染专门卡片,
  // 而非原始"$ 命令 + JSON"终端块。不认/出错 → 回落下方通用渲染。
  const ocCard = researchToolCard(command, tool);
  if (ocCard) return ocCard;
  const fileWrite = detectShellFileWrites(rawCommand);
  const out = tool.output;
  // bg-bash 的 tool_result.preview 只是占位文案（"Command running in background…"），
  // 不是真实输出；后台进程的真实 stdout/stderr 走 bashTail。识别占位 → 优先 bashTail。
  const isBgPlaceholder =
    typeof out === "string" &&
    (out.startsWith("Command running in background with ID:") ||
      out.startsWith("Command was manually backgrounded by user with ID:") ||
      out.includes("was moved to the background with ID:"));
  // 单个"终端块"：$ 命令 + 输出合一渲染在同一个 Pre 内（消除"命令一框 + 输出一框"的嵌套方框感）。
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
  if (fileWrite) {
    const auditCommand = fileWrite.rawCommand;
    const status = tool.error
      ? "写入文件命令失败"
      : tool._completed
        ? `已写入 ${fileWrite.paths.length} 个文件`
        : "正在写入文件…";
    return (
      <>
        <StatusLine text={status} error={tool.error} />
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
        {headTruncated && <FileMeta>… (head 已截断, 共 {totalBytes} 字节)</FileMeta>}
        <FileMeta>原始终端命令</FileMeta>
        <Pre>
          {auditCommand && (
            <>
              <span className="text-success">$ </span>
              {auditCommand}
              {outText ? "\n" : ""}
            </>
          )}
          {outText}
        </Pre>
      </>
    );
  }
  return (
    <>
      {headTruncated && <FileMeta>… (head 已截断, 共 {totalBytes} 字节)</FileMeta>}
      <Pre>
        {command && (
          <>
            <span className="text-success">$ </span>
            {command}
            {outText ? "\n" : ""}
          </>
        )}
        {outText}
      </Pre>
    </>
  );
}

function EditBody({ input, tool }: BodyProps) {
  const oldStr = asStr(input?.old_string).slice(0, 3000);
  const newStr = asStr(input?.new_string).slice(0, 3000);
  const out = tool.output;
  return (
    <>
      {(oldStr || newStr) && <DiffView oldStr={oldStr} newStr={newStr} />}
      {out && <StatusLine text={out.slice(0, tool.error ? 300 : 200)} error={tool.error} />}
    </>
  );
}

function ReadBody({ input, tool }: BodyProps) {
  const parts: string[] = [];
  if (input?.offset != null && input.offset !== "") parts.push(`行 ${String(input.offset)}`);
  if (input?.limit != null && input.limit !== "") parts.push(`${String(input.limit)} 行`);
  const out = tool.output;
  return (
    <>
      {parts.length > 0 && <FileMeta>{parts.join(", ")}</FileMeta>}
      {out && (
        <Pre>
          {out.slice(0, 2000)}
          {out.length > 2000 ? "\n…" : ""}
        </Pre>
      )}
    </>
  );
}

function WriteBody({ input, tool }: BodyProps) {
  const content = asStr(input?.content);
  const out = tool.output;
  return (
    <>
      {content && (
        <Pre>
          {content.slice(0, 500)}
          {content.length > 500 ? "\n…" : ""}
        </Pre>
      )}
      {out && <StatusLine text={out.slice(0, 200)} error={tool.error} />}
    </>
  );
}

function GrepBody({ input, tool }: BodyProps) {
  const parts: string[] = [];
  if (input?.path) parts.push(shortPath(input.path));
  if (input?.glob) parts.push(`glob: ${asStr(input.glob)}`);
  if (input?.output_mode) parts.push(asStr(input.output_mode));
  const out = tool.output;
  return (
    <>
      {parts.length > 0 && <FileMeta>{parts.join(" · ")}</FileMeta>}
      {out && (
        <Pre>
          {out.slice(0, 2000)}
          {out.length > 2000 ? "\n…" : ""}
        </Pre>
      )}
    </>
  );
}

function GlobBody({ input, tool }: BodyProps) {
  const out = tool.output;
  return (
    <>
      {input?.path && <FileMeta>{shortPath(input.path)}</FileMeta>}
      {out && (
        <Pre>
          {out.slice(0, 2000)}
          {out.length > 2000 ? "\n…" : ""}
        </Pre>
      )}
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
          <div key={i} className="flex items-start gap-2 text-[13px]">
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
      <OutputBlock output={tool.output} />
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
        className="mt-1.5 block break-all rounded-md border border-border bg-hover px-3 py-2 text-xs text-accent hover:bg-accent-soft"
      >
        {url}
      </a>
    ) : (
      <div className="mt-1.5 block break-all rounded-md border border-border bg-hover px-3 py-2 text-xs text-muted">
        {url}
      </div>
    );
  } else if (op === "browser_evaluate" || op === "browser_run_code") {
    const code = asStr(input?.code) || asStr(input?.function);
    if (code) head = <Pre>{code.slice(0, 1500)}</Pre>;
  } else if (input) {
    head = <KvList obj={input} skip={["_meta"]} />;
  }
  return (
    <>
      {head}
      <OutputBlock output={tool.output} />
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
    return (
      <>
        {target && <FileMeta>{shortPath(target)}</FileMeta>}
        <OutputBlock output={tool.output} />
      </>
    );
  }
  if (type === "imageGeneration") {
    const prompt = asStr(input?.prompt) || asStr(input?.revisedPrompt);
    const savedPath = extractImageGenerationPath(input, tool.output);
    const running = !tool._completed && !tool.error;
    const output = stripDuplicateImageGenerationOutput(tool.output, savedPath);
    return (
      <>
        {prompt && <PromptBlock>{prompt}</PromptBlock>}
        {running && <StatusLine text="图片生成中，通常需要几十秒，请稍候…" />}
        {!running && !tool.error && <StatusLine text="图片已生成" />}
        {savedPath && <FileMeta>{shortPath(savedPath)}</FileMeta>}
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
          skip={["id", "type", "pluginId", "result", "structuredContent", "_meta", "status", "durationMs"]}
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
            <span className="truncate font-mono text-[13px] font-semibold text-fg">{name || "(未命名)"}</span>
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
          {rationale && <p className="mt-1 text-[11.5px] text-faint">理由:{rationale}</p>}
        </div>
      </div>
      {body && (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-accent hover:underline">查看技能正文</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
            {body}
          </pre>
        </details>
      )}
      <OutputBlock output={tool.output} />
    </div>
  );
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
  let kv: ReactNode = null;
  if (input) {
    if (op === "memory") {
      kv = <KvList obj={{ op: input.op, section: input.section, content: input.content }} />;
    } else if (op === "create_reminder") {
      kv = (
        <KvList
          obj={{
            schedule: input.schedule,
            message: input.message,
            label: input.label,
            oneshot: input.oneshot,
            deliver: input.deliver,
          }}
        />
      );
    } else if (op === "delegate_task" || op === "send_to_agent") {
      kv = (
        <KvList
          obj={{
            agent: input.agentId,
            goal: input.goal,
            message: input.message,
            prompt: input.prompt,
            context: input.context,
          }}
        />
      );
    } else {
      kv = <KvList obj={input} />;
    }
  }
  const btns: ReactNode[] = [];
  if (["memory", "archival_add", "archival_search", "session_search"].includes(op) && actions.onOpenMemory) {
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
  if (op === "create_reminder" && actions.onOpenTasks) {
    btns.push(
      <Button key="tk" variant="ghost" size="sm" onClick={actions.onOpenTasks}>
        查看定时任务
      </Button>,
    );
  }
  return (
    <>
      {kv}
      <OutputBlock output={tool.output} />
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
            <div className="break-words text-[13px] font-medium text-fg">
              {asStr(r.title) || asStr(r.display_name) || asStr(r.identifier) || asStr(r.doi) || "Untitled paper"}
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

function GenericBody({ input, tool }: BodyProps) {
  return (
    <>
      {input && typeof input === "object" && <KvList obj={input} />}
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
  }
  return <GenericBody input={input} tool={tool} />;
}
