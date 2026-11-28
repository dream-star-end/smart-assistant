import type {
  SwarmBoardPost,
  SwarmMemberRole,
  SwarmMemberSnapshot,
  SwarmMemberStatus,
  SwarmPhase,
  SwarmSnapshot,
} from "@openclaude/protocol/browser";
import { isSwarmActive } from "./swarmDetect";
export {
  extractSwarmSnapshotFromMessage,
  isSwarmActive,
  latestSwarmSnapshot,
  type SwarmOpenRequest,
} from "./swarmDetect";

export function swarmPhaseMeta(phase: SwarmPhase): {
  label: string;
  tone: "accent" | "success" | "warning" | "danger";
  live: boolean;
} {
  switch (phase) {
    case "starting":
      return { label: "蜂群集结中", tone: "accent", live: true };
    case "running":
      return { label: "蜂群协作中", tone: "accent", live: true };
    case "completed":
      return { label: "协作完成", tone: "success", live: false };
    case "interrupted":
      return { label: "已中断", tone: "warning", live: false };
    case "error":
      return { label: "协作异常", tone: "danger", live: false };
  }
}

export function swarmRoleLabel(role: SwarmMemberRole): string {
  switch (role) {
    case "coordinator":
      return "协调者";
    case "verifier":
      return "校验者";
    case "monitor":
      return "监控";
    case "narrator":
      return "解说";
    default:
      return "执行者";
  }
}

export function swarmStatusLabel(status: SwarmMemberStatus): string {
  switch (status) {
    case "working":
      return "运行中";
    case "waiting":
      return "待命";
    case "stopped":
      return "已暂停";
    case "killed":
      return "已回收";
  }
}

export type MemberVisualStyle = {
  badge: string;
  avatar: string;
  dot: string;
  text: string;
};

/** Aurora-calibrated, WCAG-AA member palette derived deterministically from name. */
const MEMBER_PALETTES: readonly MemberVisualStyle[] = [
  {
    badge: "bg-accent-soft text-accent border-accent/20",
    avatar: "bg-accent-soft text-accent",
    dot: "bg-accent",
    text: "text-accent",
  },
  {
    badge: "bg-info-soft text-info border-info/20",
    avatar: "bg-info-soft text-info",
    dot: "bg-info",
    text: "text-info",
  },
  {
    badge: "bg-success-soft text-success border-success/20",
    avatar: "bg-success-soft text-success",
    dot: "bg-success",
    text: "text-success",
  },
  {
    badge: "bg-warning-soft text-warning border-warning/20",
    avatar: "bg-warning-soft text-warning",
    dot: "bg-warning",
    text: "text-warning",
  },
  {
    badge: "bg-hover text-fg border-border-strong",
    avatar: "bg-hover text-fg",
    dot: "bg-muted",
    text: "text-fg",
  },
];

export function swarmMemberStyle(name: string, role?: SwarmMemberRole): MemberVisualStyle {
  if (role === "coordinator" || name.toLowerCase() === "coordinator") {
    return MEMBER_PALETTES[0]!;
  }
  if (role === "verifier") return MEMBER_PALETTES[2]!;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const idx = (Math.abs(hash) % (MEMBER_PALETTES.length - 1)) + 1;
  return MEMBER_PALETTES[idx] ?? MEMBER_PALETTES[0]!;
}

export function memberInitial(name: string): string {
  const clean = name.replace(/^@/, "").trim();
  if (!clean) return "?";
  if (clean.toLowerCase() === "coordinator") return "主";
  return clean.slice(0, 1).toUpperCase();
}

export function humanizeSwarmModel(raw?: string): string {
  if (!raw) return "";
  const s = raw.trim();
  if (!s) return "";
  const cleaned = s.replace(/^antigravity-/i, "");
  const effortMatch = /-(low|medium|high|xhigh)$/i.exec(cleaned);
  const effortLabel = effortMatch
    ? effortMatch[1]!.toLowerCase() === "xhigh"
      ? "XHigh"
      : effortMatch[1]![0]!.toUpperCase() + effortMatch[1]!.slice(1).toLowerCase()
    : "";
  const suffix = effortLabel ? ` · ${effortLabel}` : "";
  if (/gemini-pro-orchestrator-neon|orchestrator-neon/i.test(cleaned)) return "Orchestrator Neon";
  if (/gemini-pro-orchestrator|orchestrator-carbon/i.test(cleaned)) return "Orchestrator Carbon";
  if (/gemini-4-neon/i.test(cleaned)) return `Gemini 4 Neon${suffix}`;
  if (/gemini-4-carbon/i.test(cleaned)) return `Gemini 4 Carbon${suffix}`;
  if (/gemini-4-hydrogen/i.test(cleaned)) return `Gemini 4 Hydrogen${suffix}`;
  if (/gemini-4-argon/i.test(cleaned)) return `Gemini 4 Argon${suffix}`;
  if (/gemini-3\.8-flash/i.test(cleaned)) return `Gemini 3.8 Flash${suffix}`;
  if (/claude-opus-5[-.]5/i.test(cleaned)) return `Claude Opus 5.5${suffix}`;
  if (/claude-sonnet-5[-.]5/i.test(cleaned)) return `Claude Sonnet 5.5${suffix}`;
  if (/claude-opus/i.test(cleaned)) return `Claude Opus${suffix}`;
  if (/claude-sonnet/i.test(cleaned)) return `Claude Sonnet${suffix}`;
  if (/gpt-oss-120b/i.test(cleaned)) return "GPT-OSS 120B";
  return cleaned
    .split(/[-_]+/)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

export function formatSwarmElapsed(startedAt?: number, nowMs: number = Date.now()): string {
  if (!startedAt || startedAt <= 0) return "";
  const totalSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** 将成员增量遥测耗时（ms）格式化为紧凑可读时长。 */
export function formatTelemetryDuration(elapsedMs?: number): string {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)}ms`;
  const totalSec = elapsedMs / 1_000;
  if (totalSec < 60) return `${totalSec < 10 ? totalSec.toFixed(1) : Math.round(totalSec)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  if (mins < 60) return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h${remMins}m` : `${hrs}h`;
}

/** 将 token 数量格式化为紧凑数值（如 1.2k / 1.4M）。 */
export function formatCompactTokenCount(tokens?: number): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export function formatTelemetryTokens(inputTokens?: number, outputTokens?: number): string {
  const hasIn = typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0;
  const hasOut = typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0;
  if (!hasIn && !hasOut) return "";
  const parts: string[] = [];
  if (hasIn) parts.push(`${formatCompactTokenCount(inputTokens)}↑`);
  if (hasOut) parts.push(`${formatCompactTokenCount(outputTokens)}↓`);
  return parts.join(" ");
}

export function hasMemberTelemetry(member: SwarmMemberSnapshot): boolean {
  return (
    (typeof member.elapsedMs === "number" && Number.isFinite(member.elapsedMs)) ||
    (typeof member.inputTokens === "number" && Number.isFinite(member.inputTokens)) ||
    (typeof member.outputTokens === "number" && Number.isFinite(member.outputTokens)) ||
    (typeof member.cacheReadTokens === "number" && Number.isFinite(member.cacheReadTokens)) ||
    (typeof member.thinkingTokens === "number" && Number.isFinite(member.thinkingTokens)) ||
    (typeof member.toolCalls === "number" && Number.isFinite(member.toolCalls))
  );
}

export type SwarmTelemetrySummary = {
  hasTokens: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  toolCalls: number;
  cacheHitRatePct: number | null;
  partial: boolean;
};

/** 汇总整群 Token / 缓存命中率 / 思考 Token / 工具调用（向后兼容缺省字段的旧快照）。 */
export function summarizeSwarmTelemetry(members: readonly SwarmMemberSnapshot[]): SwarmTelemetrySummary {
  let hasTokens = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;
  let toolCalls = 0;
  let partial = false;
  for (const m of members) {
    if (typeof m.inputTokens === "number" && Number.isFinite(m.inputTokens) && m.inputTokens >= 0) {
      inputTokens += m.inputTokens;
      hasTokens = true;
    }
    if (typeof m.outputTokens === "number" && Number.isFinite(m.outputTokens) && m.outputTokens >= 0) {
      outputTokens += m.outputTokens;
      hasTokens = true;
    }
    if (typeof m.cacheReadTokens === "number" && Number.isFinite(m.cacheReadTokens) && m.cacheReadTokens >= 0) {
      cacheReadTokens += m.cacheReadTokens;
      if (m.cacheReadTokens > 0) hasTokens = true;
    }
    if (typeof m.thinkingTokens === "number" && Number.isFinite(m.thinkingTokens) && m.thinkingTokens >= 0) {
      thinkingTokens += m.thinkingTokens;
    }
    if (typeof m.toolCalls === "number" && Number.isFinite(m.toolCalls) && m.toolCalls >= 0) {
      toolCalls += m.toolCalls;
    }
    if (m.telemetryPartial) partial = true;
  }
  const cacheDenom = inputTokens + cacheReadTokens;
  const cacheHitRatePct =
    cacheReadTokens > 0 && cacheDenom > 0
      ? Math.min(100, Math.round((cacheReadTokens / cacheDenom) * 100))
      : null;
  return {
    hasTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
    toolCalls,
    cacheHitRatePct,
    partial,
  };
}

export type SwarmPostSemantic = {
  kind: "done" | "stall" | "control_kill" | "steer";
  label: string;
  tone: "success" | "warning" | "danger" | "info";
  calloutClass: string;
};

/** 识别讨论板帖子的一等语义标记（[done] / [stall] / [control:kill] / [steer]）。 */
export function classifySwarmPost(post: SwarmBoardPost): SwarmPostSemantic | null {
  const trimmed = post.text.trimStart();
  if (trimmed.startsWith("[done]")) {
    return { kind: "done", label: "阶段完结", tone: "success", calloutClass: "oc-callout oc-callout-success" };
  }
  if (trimmed.startsWith("[stall]")) {
    return { kind: "stall", label: "停滞预警", tone: "warning", calloutClass: "oc-callout oc-callout-warning" };
  }
  if (trimmed.startsWith("[control:kill]")) {
    return { kind: "control_kill", label: "成员回收", tone: "danger", calloutClass: "oc-callout oc-callout-danger" };
  }
  if (trimmed.startsWith("[steer]") || post.agent.toLowerCase().startsWith("user:")) {
    return { kind: "steer", label: "人工指令", tone: "info", calloutClass: "oc-callout oc-callout-info" };
  }
  return null;
}

export type SwarmAlertSummary = {
  hasAlert: boolean;
  failedMembers: SwarmMemberSnapshot[];
  unresolvedStalls: SwarmBoardPost[];
  primaryFocusMember: string | null;
  primaryFocusSeq: number | null;
  summary: string;
};

/** 聚合未解决的 `[stall]` 预警与 `failed` 异常成员，供抽屉顶栏与实时胶囊一键定位。 */
export function detectSwarmAlerts(snapshot: SwarmSnapshot): SwarmAlertSummary {
  const failedMembers = snapshot.members.filter((m) => Boolean(m.failed));
  const active = isSwarmActive(snapshot.phase);
  const memberByName = new Map(snapshot.members.map((m) => [m.name.toLowerCase(), m]));
  const latestNonStallByAgent = new Map<string, number>();
  for (const p of snapshot.posts) {
    if (!p.text.trimStart().startsWith("[stall]")) {
      const k = p.agent.toLowerCase();
      latestNonStallByAgent.set(k, Math.max(latestNonStallByAgent.get(k) ?? 0, p.seq));
    }
  }
  const unresolvedStalls: SwarmBoardPost[] = [];
  if (active) {
    for (const p of snapshot.posts) {
      if (!p.text.trimStart().startsWith("[stall]")) continue;
      const mentionedWorkers = p.mentions.filter(
        (m) => m !== "all" && m !== "coordinator" && memberByName.has(m),
      );
      if (mentionedWorkers.length === 0) {
        // 群级停滞：若之后尚未出现更新的非 stall 进展，视为仍未解决
        const hasNewerProgress = snapshot.posts.some(
          (other) => other.seq > p.seq && !other.text.trimStart().startsWith("[stall]"),
        );
        if (!hasNewerProgress) unresolvedStalls.push(p);
      } else {
        const stillStalled = mentionedWorkers.some((name) => {
          const member = memberByName.get(name);
          if (!member || member.status === "killed") return false;
          const latestSeq = latestNonStallByAgent.get(name) ?? 0;
          return latestSeq <= p.seq;
        });
        if (stillStalled) unresolvedStalls.push(p);
      }
    }
  }

  const latestStall = unresolvedStalls[unresolvedStalls.length - 1] ?? null;
  const firstFailed = failedMembers[0] ?? null;
  const stallMember =
    latestStall?.mentions.find((m) => m !== "all" && m !== "coordinator" && memberByName.has(m)) ?? null;
  const primaryFocusMember = firstFailed?.name ?? stallMember ?? null;
  const primaryFocusSeq = latestStall?.seq ?? firstFailed?.lastPostSeq ?? null;
  const hasAlert = failedMembers.length > 0 || unresolvedStalls.length > 0;

  let summary = "";
  if (failedMembers.length > 0 && unresolvedStalls.length > 0) {
    summary = `${failedMembers.length} 名成员异常 · ${unresolvedStalls.length} 条停滞预警`;
  } else if (failedMembers.length > 0) {
    summary =
      failedMembers.length === 1
        ? `@${failedMembers[0]!.name} 执行异常`
        : `${failedMembers.length} 名成员执行异常`;
  } else if (unresolvedStalls.length > 0) {
    summary = stallMember ? `@${stallMember} 停滞预警` : `${unresolvedStalls.length} 条停滞预警`;
  }

  return {
    hasAlert,
    failedMembers,
    unresolvedStalls,
    primaryFocusMember,
    primaryFocusSeq,
    summary,
  };
}

const LEGACY_UTC_BOARD_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function formatPostClock(time?: string): string {
  if (!time) return "";
  const trimmed = time.trim();
  if (!trimmed) return "";
  const normalized = LEGACY_UTC_BOARD_TIME_RE.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function swarmWorkspaceBadge(workspace?: string): {
  label: string;
  title: string;
  isolated: boolean;
} | null {
  const norm = workspace?.trim().toLowerCase();
  if (!norm || norm === "inherit") return null;
  if (norm === "share") {
    return {
      label: "worktree",
      title: "独立 Git Worktree 隔离工作区（收尾前需核对并合入主工作区）",
      isolated: true,
    };
  }
  if (norm === "branch") {
    return {
      label: "独立分支",
      title: "独立克隆隔离工作区（收尾前需核对并合入主工作区）",
      isolated: true,
    };
  }
  return {
    label: norm,
    title: `独立工作区（${norm}）`,
    isolated: true,
  };
}

export function summarizeSwarmCounts(members: readonly SwarmMemberSnapshot[]): {
  total: number;
  live: number;
  working: number;
  waiting: number;
  killed: number;
  failed: number;
  isolatedWorktrees: number;
  activeIsolatedWorktrees: number;
} {
  let working = 0;
  let waiting = 0;
  let killed = 0;
  let failed = 0;
  let isolatedWorktrees = 0;
  let activeIsolatedWorktrees = 0;
  for (const m of members) {
    if (m.status === "killed") killed += 1;
    else if (m.status === "working") working += 1;
    else waiting += 1;
    if (m.failed) failed += 1;
    if (swarmWorkspaceBadge(m.workspace)?.isolated) {
      isolatedWorktrees += 1;
      if (m.status !== "killed") activeIsolatedWorktrees += 1;
    }
  }
  return {
    total: members.length,
    live: members.length - killed,
    working,
    waiting,
    killed,
    failed,
    isolatedWorktrees,
    activeIsolatedWorktrees,
  };
}

function isAuxiliarySwarmPost(post: SwarmBoardPost, members: readonly SwarmMemberSnapshot[]): boolean {
  const agentLower = post.agent.trim().toLowerCase();
  if (agentLower === "gateway-monitor" || /^monitor(?:-\d+)?$/.test(agentLower)) {
    return true;
  }
  if (post.text.trimStart().startsWith("[stall]")) return true;
  const member = members.find((m) => m.name.toLowerCase() === agentLower);
  return member?.role === "monitor" || member?.role === "narrator";
}

/**
 * 格式化底部 LiveAgentCapsule 的蜂群运行态摘要，严格区分「正在运行的核心成员」与「待命时最新发言者」，
 * 杜绝将刚发完预警帖的 `gateway-monitor` 拼接在 `运行中` 后造成误导（OCV5-932 Defect #4）。
 */
export function formatSwarmCapsuleDetail(snapshot: SwarmSnapshot): string {
  if (!isSwarmActive(snapshot.phase)) {
    return swarmPhaseMeta(snapshot.phase).label;
  }
  const allWorking = snapshot.members.filter((m) => m.status === "working");
  const coreWorking = allWorking.filter((m) => m.role !== "monitor" && m.role !== "narrator");
  const activeWorking = coreWorking.length > 0 ? coreWorking : allWorking;
  if (activeWorking.length === 1) {
    return `1 运行中：${activeWorking[0]!.name}`;
  }
  if (activeWorking.length > 1) {
    const names = activeWorking
      .slice(0, 2)
      .map((m) => m.name)
      .join("、");
    return `${activeWorking.length} 运行中：${names}${activeWorking.length > 2 ? " 等" : ""}`;
  }
  const counts = summarizeSwarmCounts(snapshot.members);
  if (counts.live === 0) {
    return swarmPhaseMeta(snapshot.phase).label;
  }
  const latestPost = snapshot.posts[snapshot.posts.length - 1] ?? null;
  if (latestPost && !isAuxiliarySwarmPost(latestPost, snapshot.members)) {
    return `${counts.live} 成员待命 · 最新 ${latestPost.agent}`;
  }
  return `${counts.live} 成员待命`;
}

export function postMatchesMember(post: SwarmBoardPost, memberName: string): boolean {
  const target = memberName.toLowerCase();
  if (post.agent.toLowerCase() === target) return true;
  if (post.mentions.some((m) => m === target || m === "all")) return true;
  // Numbered group prefix match: `@worker` matches `worker-1`.
  const baseMatch = /^([a-z0-9._-]+)-\d+$/.exec(target);
  if (baseMatch && post.mentions.includes(baseMatch[1]!)) return true;
  return false;
}

export type SwarmTextToken =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; target: string }
  | { kind: "channel_mention"; value: string; channel: string }
  | { kind: "seq"; value: string; seq: number };

const TOKEN_RE = /(@#[A-Za-z0-9][A-Za-z0-9._-]{0,63}|@[A-Za-z0-9][A-Za-z0-9._-]{0,63}|#\d{1,5})\b/g;

function matchFenceOpenLine(line: string): { ch: string; len: number } | null {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i += 1;
  const ch = line[i];
  if (ch !== "`" && ch !== "~") return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len += 1;
  if (len < 3) return null;
  if (ch === "`" && line.indexOf("`", i + len) !== -1) return null;
  return { ch, len };
}

function isFenceCloseLine(line: string, ch: string, minLen: number): boolean {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t" || line[i] === ">")) i += 1;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len += 1;
  if (len < minLen) return false;
  for (let j = i + len; j < line.length; j += 1) {
    if (line[j] !== " " && line[j] !== "\t" && line[j] !== "\r") return false;
  }
  return true;
}

function collectInlineRangesInSlice(text: string, sliceStart: number, sliceEnd: number, out: Array<readonly [number, number]>): void {
  const runs: Array<{ start: number; len: number }> = [];
  const byLen = new Map<number, number[]>();
  for (let i = sliceStart; i < sliceEnd; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let len = 1;
    while (i + len < sliceEnd && text[i + len] === "`") len += 1;
    const idx = runs.length;
    runs.push({ start: i, len });
    const bucket = byLen.get(len);
    if (bucket) bucket.push(idx);
    else byLen.set(len, [idx]);
    i += len;
  }
  const ptrByLen = new Map<number, number>();
  for (let r = 0; r < runs.length; ) {
    const open = runs[r]!;
    const bucket = byLen.get(open.len)!;
    let ptr = ptrByLen.get(open.len) ?? 0;
    while (ptr < bucket.length && bucket[ptr]! <= r) ptr += 1;
    ptrByLen.set(open.len, ptr);
    if (ptr < bucket.length) {
      const close = runs[bucket[ptr]!]!;
      out.push([open.start, close.start + close.len]);
      ptrByLen.set(open.len, ptr + 1);
      r = bucket[ptr]! + 1;
    } else {
      r += 1;
    }
  }
}

export function collectSwarmCodeRanges(text: string): Array<readonly [number, number]> {
  if (text.indexOf("`") === -1 && text.indexOf("~") === -1) return [];
  const ranges: Array<readonly [number, number]> = [];
  let fence: { ch: string; len: number; start: number } | null = null;
  let plainStart = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl >= 0 ? nl : text.length;
    const nextStart = nl >= 0 ? nl + 1 : text.length + 1;
    const line = text.slice(lineStart, lineEnd);
    if (fence) {
      if (isFenceCloseLine(line, fence.ch, fence.len)) {
        ranges.push([fence.start, Math.min(text.length, nextStart)]);
        fence = null;
        plainStart = Math.min(text.length, nextStart);
      }
    } else {
      const opened = matchFenceOpenLine(line);
      if (opened) {
        if (lineStart > plainStart) collectInlineRangesInSlice(text, plainStart, lineStart, ranges);
        fence = { ch: opened.ch, len: opened.len, start: lineStart };
      }
    }
    if (nl < 0) break;
    lineStart = nextStart;
  }
  if (fence) {
    ranges.push([fence.start, text.length]);
  } else if (plainStart < text.length) {
    collectInlineRangesInSlice(text, plainStart, text.length, ranges);
  }
  return ranges;
}

export function tokenizeSwarmInlineText(text: string): SwarmTextToken[] {
  if (!text) return [];
  const codeRanges = collectSwarmCodeRanges(text);
  let rangeIdx = 0;
  const out: SwarmTextToken[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const start = match.index;
    const raw = match[1]!;
    while (rangeIdx < codeRanges.length && codeRanges[rangeIdx]![1] <= start) rangeIdx += 1;
    if (rangeIdx < codeRanges.length && start >= codeRanges[rangeIdx]![0]) continue;
    // Only treat as token at start of line or after non-word char (avoid emails & scoped paths).
    const prevChar = start > 0 ? text[start - 1]! : "";
    if (prevChar && /[A-Za-z0-9_.+-]/.test(prevChar)) continue;
    const nextChar = text[start + raw.length] ?? "";
    if (raw.startsWith("@") && nextChar === "/") continue;
    if (start > lastIndex) {
      out.push({ kind: "text", value: text.slice(lastIndex, start) });
    }
    if (raw.startsWith("@#")) {
      out.push({ kind: "channel_mention", value: raw, channel: raw.slice(2).toLowerCase() });
    } else if (raw.startsWith("@")) {
      out.push({ kind: "mention", value: raw, target: raw.slice(1).toLowerCase() });
    } else if (raw.startsWith("#")) {
      const seq = Number.parseInt(raw.slice(1), 10);
      if (Number.isFinite(seq) && seq > 0) {
        out.push({ kind: "seq", value: raw, seq });
      } else {
        out.push({ kind: "text", value: raw });
      }
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return out;
}
