import type { ChatMessage } from "../../lib/chat/model";
import {
  combineStepTimings,
  detectOcCli,
  detectShellFileWrites,
  normalizeToolForDisplay,
  parseCodexTypeName,
  stripShellWrapperForDisplay,
  toolChangedFileCount,
  type StepTiming,
  type ToolInput,
} from "./ProcessDisclosure";

/**
 * Semantic phase kinds for grouping long multi-step turns into an executive timeline.
 * Keeps raw commands/paths out of collapsed summaries and never fabricates durations.
 */
export type PhaseKind = "explore" | "edit" | "verify" | "collab" | "plan";

export interface PhaseDefinition {
  kind: PhaseKind;
  /** Full semantic label shown in expanded headers and accessible labels. */
  label: string;
  /** Compact label for dense phase capsules. */
  shortLabel: string;
}

export const PHASE_DEFINITIONS: Readonly<Record<PhaseKind, PhaseDefinition>> = {
  explore: { kind: "explore", label: "检索探索", shortLabel: "检索探索" },
  edit: { kind: "edit", label: "代码与产物编辑", shortLabel: "编辑产物" },
  verify: { kind: "verify", label: "命令与验证", shortLabel: "命令验证" },
  collab: { kind: "collab", label: "多代理协作", shortLabel: "多代理协作" },
  plan: { kind: "plan", label: "思考与规划", shortLabel: "思考规划" },
};

export interface PhaseMetrics {
  exploreCount: number;
  editCount: number;
  changedFileCount: number;
  commandCount: number;
  collabCount: number;
  planCount: number;
}

export interface PhaseSegment {
  kind: PhaseKind;
  label: string;
  shortLabel: string;
  messageIds: string[];
  stepCount: number;
  failedCount: number;
  runningCount: number;
  /** Combined duration in ms only when trustworthy timings exist; never fabricated. */
  durationMs?: number;
  active: boolean;
  completed: boolean;
  changedFileCount: number;
}

export interface PhaseTimelineData {
  /** Distinct semantic phases ordered by first appearance (aggregated across the turn). */
  phases: PhaseSegment[];
  /** Chronological contiguous phase runs (e.g. explore -> edit -> verify -> edit -> verify). */
  runs: PhaseSegment[];
  /** Turn-wide key work metrics. */
  metrics: PhaseMetrics;
  /** Total classified work steps. */
  totalSteps: number;
  /** Total missed / errored steps (quiet fact, never red-alarmed inside disclosure). */
  totalFailed: number;
  /** Currently active phase while turn is running, or null when settled. */
  activePhase: PhaseKind | null;
  /** One-line human-readable progress summary for the turn. */
  summaryText: string;
  /** Show compact capsule bar on collapsed shell when the turn is multi-phase or long. */
  showCompactBar: boolean;
  /** Show phase filter bar when expanded and at least 2 semantic phases exist. */
  showFilterBar: boolean;
}

const SHELL_TOOLS = new Set(["bash", "shell", "run_terminal_command", "run_terminal_cmd", "run_command"]);
const CAT_WRITE_RE = /(?:^|[^0-9&<>])>>?\s*[^\s&|>]/;

const COLLAB_TOOL_TOKENS = new Set([
  "task",
  "agent",
  "taskoutput",
  "task_output",
  "taskstop",
  "task_stop",
  "delegate_task",
  "delegate_tasks",
  "delegate_wait",
  "request_review",
  "swarmboard",
  "swarm_board",
  "swarmmanage",
  "swarm_manage",
  "swarmpost",
  "swarm_post",
  "swarmreadboard",
  "swarm_read_board",
  "swarmwait",
  "swarm_wait",
  "swarm",
  "post_message",
  "read_board",
  "invoke_subagent",
  "define_subagent",
  "send_message",
  "subagentactivity",
]);

const PLAN_TOOL_TOKENS = new Set([
  "todowrite",
  "todo_write",
  "enterplanmode",
  "enter_plan_mode",
  "exitplanmode",
  "exit_plan_mode",
  "askuserquestion",
  "ask_user_question",
]);

const EDIT_TOOL_TOKENS = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "apply_patch",
  "patch",
  "write_file",
  "edit_file",
  "create_file",
  "replace_file_content",
  "multi_replace_file_content",
  "imagegen",
  "image_gen",
  "image_generation",
  "generate_image",
  "text_to_image",
  "generate_video",
  "music_generation",
]);

const EDIT_OC_CLIS = new Set([
  "oc-report",
  "oc-slides",
  "oc-poster",
  "oc-pdf",
  "oc-docx",
  "oc-xlsx",
  "oc-minimax",
  "mmx",
]);

const EXPLORE_TOOL_TOKENS = new Set([
  "read",
  "view",
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "grep",
  "grep_search",
  "glob",
  "glob_file_search",
  "globfilesearch",
  "find_by_name",
  "list_dir",
  "websearch",
  "web_search",
  "search_web",
  "webfetch",
  "web_fetch",
  "mcpsearch",
  "search_tool",
  "searchextratools",
  "search_extra_tools",
  "semantic_search",
  "semanticsearch",
  "skill",
  "skill_view",
  "skill_list",
  "skill_search",
  "view_image",
  "understand_image",
  "imageview",
]);

const EXPLORE_OC_CLIS = new Set([
  "oc-web",
  "oc-web-context",
  "oc-lit",
  "oc-litrag",
  "oc-cite",
  "oc-rank",
  "oc-ingest",
  "ths",
]);

const EXPLORE_MCP_SERVERS = new Set([
  "scansci-pdf",
  "web-context",
  "minimax-vision",
  "openclaude-vision",
  "quant-system",
]);

const READ_SHELL_BINS = new Set(["cat", "head", "tail", "rg", "grep", "find", "ls", "tree", "wc", "stat", "file"]);
const READ_GIT_OPS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"]);

function normalizeToken(raw: string): string {
  let token = raw.trim();
  const lower = token.toLowerCase();
  const mcpAt = lower.indexOf("mcp__");
  if (mcpAt >= 0) {
    const segs = token.slice(mcpAt + 5).split("__");
    token = (segs.length >= 2 ? segs[segs.length - 1] : segs[0]) ?? token;
  } else if (lower.startsWith("codex:")) {
    token = token.slice(token.indexOf(":") + 1);
  }
  return token.replace(/-/g, "_").toLowerCase();
}

function mcpServerOf(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const mcpAt = lower.indexOf("mcp__");
  if (mcpAt < 0) return "";
  return lower.slice(mcpAt + 5).split("__")[0] ?? "";
}

function commandOf(input: ToolInput, message: ChatMessage): string {
  if (input) {
    if (typeof input.command === "string") return input.command;
    if (typeof input.cmd === "string") return input.cmd;
  }
  if (typeof message.inputPreview === "string") return message.inputPreview;
  return "";
}

function shellHeadTokens(command: string): { bin: string; arg1: string } {
  const cleaned = stripShellWrapperForDisplay(command).trim();
  if (!cleaned) return { bin: "", arg1: "" };
  const parts = cleaned.split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i] ?? "")) i += 1;
  const rawBin = (parts[i] ?? "").replace(/^['"]|['"]$/g, "");
  const bin = (rawBin.split("/").pop() ?? rawBin).toLowerCase();
  const arg1 = (parts[i + 1] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase();
  return { bin, arg1 };
}

function isMessageErrored(message: ChatMessage): boolean {
  return Boolean(
    message.error ||
      message._isError ||
      message._errorCode ||
      message._delegateStatus === "failed" ||
      message._delegateStatus === "timeout",
  );
}

function isMessageRunning(message: ChatMessage): boolean {
  if (message.role === "tool") {
    return !message._completed && !message.error && !message._isError;
  }
  if (message.role === "agent-group" || message.role === "delegate-progress") {
    if (message._completed === true || message._delegateStatus === "ok") return false;
    if (isMessageErrored(message)) return false;
    return true;
  }
  return false;
}

/**
 * Classifies a single process message into a semantic phase, or null if it is
 * not a work step (e.g. user prompt, assistant narration, cleared goal, status row).
 */
export function classifyMessagePhase(message: ChatMessage): PhaseKind | null {
  if (message._turnStatusRecord || message._genPlaceholder || message._turnTapeProcess) return null;
  if (message.role === "user" || message.role === "assistant" || message.role === "system" || message.role === "goal") {
    return null;
  }
  if (message.role === "agent-group" || message.role === "delegate-progress") return "collab";
  if (message.role === "thinking" || message.role === "plan" || message.role === "permission") return "plan";
  if (message.role !== "tool") return null;

  let name = message.toolName ?? "";
  let input: ToolInput = null;
  try {
    const display = normalizeToolForDisplay(message);
    name = display.name || name;
    input = display.input;
  } catch {
    /* keep raw toolName */
  }

  const token = normalizeToken(name);
  const server = mcpServerOf(name);
  const codex = parseCodexTypeName(name);
  const rawCommand = commandOf(input, message);
  const unwrappedCommand = stripShellWrapperForDisplay(rawCommand);
  const cli = detectOcCli(unwrappedCommand);
  const head = shellHeadTokens(rawCommand);

  // 1. Multi-agent / swarm collaboration
  if (COLLAB_TOOL_TOKENS.has(token) || codex === "subAgentActivity") return "collab";
  if (cli === "oc-memory" && (head.arg1 === "delegate" || head.arg1 === "delegate-wait" || head.arg1 === "request-review")) {
    return "collab";
  }
  if (server === "openclaude-memory" && (token.includes("delegate") || token.includes("review"))) {
    return "collab";
  }

  // 2. Planning / task tracking
  if (PLAN_TOOL_TOKENS.has(token) || cli === "oc-task") return "plan";

  // 3. Code & deliverable editing (files, sites, slides, docs, sheets, media)
  if (
    EDIT_TOOL_TOKENS.has(token) ||
    codex === "imageGeneration" ||
    server === "minimax-media" ||
    (cli !== null && EDIT_OC_CLIS.has(cli))
  ) {
    return "edit";
  }
  if (/(?:site|ppt|slide|docx|xlsx|report|poster)/.test(token) && /(?:create|write|build|gen|edit|update|export)/.test(token)) {
    return "edit";
  }
  if (SHELL_TOOLS.has(token)) {
    if (head.bin === "cat" && CAT_WRITE_RE.test(unwrappedCommand)) return "edit";
    if (detectShellFileWrites(unwrappedCommand)) return "edit";
  }

  // 4. Research & exploration (read, grep, glob, web, literature, memory)
  if (
    EXPLORE_TOOL_TOKENS.has(token) ||
    codex === "imageView" ||
    EXPLORE_MCP_SERVERS.has(server) ||
    (cli !== null && EXPLORE_OC_CLIS.has(cli))
  ) {
    return "explore";
  }
  if (cli === "oc-memory" || server === "openclaude-memory") {
    return "explore";
  }
  if (SHELL_TOOLS.has(token)) {
    if (READ_SHELL_BINS.has(head.bin)) return "explore";
    if (head.bin === "git" && READ_GIT_OPS.has(head.arg1)) return "explore";
    if (head.bin === "sed" && /-n\b/.test(unwrappedCommand)) return "explore";
  }

  // 5. Command & verification (shell execution, test/build, browser inspection, connectors)
  if (cli === "oc-browser" || server === "browser" || token.startsWith("browser_")) return "verify";
  if (SHELL_TOOLS.has(token)) return "verify";
  return "verify";
}

function buildSegment(
  kind: PhaseKind,
  rows: ChatMessage[],
  stepTimings: ReadonlyMap<string, StepTiming> | undefined,
  turnActive: boolean,
  isLatest: boolean,
): PhaseSegment {
  const def = PHASE_DEFINITIONS[kind];
  const messageIds = rows.map((m) => m.id);
  let failedCount = 0;
  let runningCount = 0;
  for (const row of rows) {
    if (isMessageErrored(row)) failedCount += 1;
    if (isMessageRunning(row)) runningCount += 1;
  }
  const combined = stepTimings ? combineStepTimings(stepTimings, messageIds) : undefined;
  const durationMs =
    combined?.ms !== undefined && Number.isFinite(combined.ms) && combined.ms >= 0 ? combined.ms : undefined;
  const active = turnActive && (runningCount > 0 || (isLatest && kind === "plan" && rows.at(-1)?.role === "thinking"));
  const completed = !active && runningCount === 0;
  const changedFileCount = kind === "edit" ? toolChangedFileCount(rows) : 0;

  return {
    kind,
    label: def.label,
    shortLabel: def.shortLabel,
    messageIds,
    stepCount: rows.length,
    failedCount,
    runningCount,
    durationMs,
    active,
    completed,
    changedFileCount,
  };
}

/**
 * Generates a single-sentence human-readable progress summary from phase segments & metrics.
 * Never exposes raw commands, file paths, or fabricated timings.
 */
export function summarizePhaseTimeline(
  phases: readonly PhaseSegment[],
  metrics: PhaseMetrics,
  activePhase: PhaseKind | null,
): string {
  if (phases.length === 0) return "";
  const metricParts: string[] = [];
  if (metrics.exploreCount > 0) metricParts.push(`检索 ${metrics.exploreCount} 次`);
  if (metrics.changedFileCount > 0) metricParts.push(`改动 ${metrics.changedFileCount} 个文件`);
  else if (metrics.editCount > 0) metricParts.push(`编辑 ${metrics.editCount} 处`);
  if (metrics.commandCount > 0) metricParts.push(`执行 ${metrics.commandCount} 条命令`);
  if (metrics.collabCount > 0) metricParts.push(`协作 ${metrics.collabCount} 项`);

  if (activePhase) {
    const activeLabel = PHASE_DEFINITIONS[activePhase].label;
    return metricParts.length > 0
      ? `当前处于${activeLabel} · 已${metricParts.join("、")}`
      : `当前处于${activeLabel}`;
  }

  const substantive = phases.filter((p) => p.kind !== "plan");
  const displayPhases = substantive.length > 0 ? substantive : phases;
  const trail = displayPhases.map((p) => p.shortLabel).join(" → ");
  return metricParts.length > 0 ? `${trail} · ${metricParts.join("、")}` : trail;
}

/**
 * Groups a turn's process messages into semantic phases, computes per-phase and
 * turn-wide statistics, and builds a one-line human progress summary.
 */
export function buildPhaseTimeline(
  messages: readonly ChatMessage[],
  options: {
    stepTimings?: ReadonlyMap<string, StepTiming>;
    active?: boolean;
  } = {},
): PhaseTimelineData {
  const turnActive = options.active === true;
  const stepTimings = options.stepTimings;

  const classified: Array<{ kind: PhaseKind; message: ChatMessage }> = [];
  const metrics: PhaseMetrics = {
    exploreCount: 0,
    editCount: 0,
    changedFileCount: 0,
    commandCount: 0,
    collabCount: 0,
    planCount: 0,
  };

  for (const message of messages) {
    const kind = classifyMessagePhase(message);
    if (!kind) continue;
    classified.push({ kind, message });
    if (kind === "explore") metrics.exploreCount += 1;
    else if (kind === "edit") metrics.editCount += 1;
    else if (kind === "verify") metrics.commandCount += 1;
    else if (kind === "collab") metrics.collabCount += 1;
    else if (kind === "plan") metrics.planCount += 1;
  }

  metrics.changedFileCount = toolChangedFileCount(messages);

  // Build chronological contiguous runs
  const rawRuns: Array<{ kind: PhaseKind; rows: ChatMessage[] }> = [];
  for (const entry of classified) {
    const prev = rawRuns.at(-1);
    if (prev && prev.kind === entry.kind) {
      prev.rows.push(entry.message);
    } else {
      rawRuns.push({ kind: entry.kind, rows: [entry.message] });
    }
  }

  const runs: PhaseSegment[] = rawRuns.map((run, idx) =>
    buildSegment(run.kind, run.rows, stepTimings, turnActive, idx === rawRuns.length - 1),
  );

  // Aggregate distinct phases in first-seen order
  const byKind = new Map<PhaseKind, ChatMessage[]>();
  const order: PhaseKind[] = [];
  for (const entry of classified) {
    let list = byKind.get(entry.kind);
    if (!list) {
      list = [];
      byKind.set(entry.kind, list);
      order.push(entry.kind);
    }
    list.push(entry.message);
  }

  const latestKind = classified.at(-1)?.kind ?? null;
  const phases: PhaseSegment[] = order.map((kind) =>
    buildSegment(kind, byKind.get(kind)!, stepTimings, turnActive, kind === latestKind),
  );

  const runningPhase = phases.find((p) => p.active)?.kind ?? null;
  const activePhase = turnActive ? (runningPhase ?? latestKind) : null;

  const totalSteps = classified.length;
  const totalFailed = phases.reduce((sum, p) => sum + p.failedCount, 0);
  const substantivePhases = phases.filter((p) => p.kind !== "plan");

  const summaryText = summarizePhaseTimeline(phases, metrics, activePhase);
  const showCompactBar = substantivePhases.length >= 2 || totalSteps >= 4;
  const showFilterBar = phases.length >= 2;

  return {
    phases,
    runs,
    metrics,
    totalSteps,
    totalFailed,
    activePhase,
    summaryText,
    showCompactBar,
    showFilterBar,
  };
}
