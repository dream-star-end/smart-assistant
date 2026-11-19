import type {
  SwarmBoardPost,
  SwarmMemberRole,
  SwarmMemberSnapshot,
  SwarmMemberStatus,
  SwarmPhase,
} from "@openclaude/protocol/browser";
export {
  extractSwarmSnapshotFromMessage,
  latestSwarmSnapshot,
  type SwarmOpenRequest,
} from "./swarmDetect";

export function isSwarmActive(phase: SwarmPhase): boolean {
  return phase === "starting" || phase === "running";
}

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
    badge: "bg-danger-soft text-danger border-danger/20",
    avatar: "bg-danger-soft text-danger",
    dot: "bg-danger",
    text: "text-danger",
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
  if (/gemini-4-neon/i.test(cleaned)) return "Gemini 4 Neon";
  if (/gemini-4-carbon/i.test(cleaned)) return "Gemini 4 Carbon";
  if (/gemini-4-hydrogen/i.test(cleaned)) return "Gemini 4 Hydrogen";
  if (/orchestrator-neon/i.test(cleaned)) return "Orchestrator Neon";
  if (/orchestrator-carbon/i.test(cleaned)) return "Orchestrator Carbon";
  if (/claude-opus/i.test(cleaned)) return "Claude Opus";
  if (/claude-sonnet/i.test(cleaned)) return "Claude Sonnet";
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

export function formatPostClock(time?: string): string {
  if (!time) return "";
  const ms = Date.parse(time);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function summarizeSwarmCounts(members: readonly SwarmMemberSnapshot[]): {
  total: number;
  live: number;
  working: number;
  waiting: number;
  killed: number;
  failed: number;
} {
  let working = 0;
  let waiting = 0;
  let killed = 0;
  let failed = 0;
  for (const m of members) {
    if (m.status === "killed") killed += 1;
    else if (m.status === "working") working += 1;
    else waiting += 1;
    if (m.failed) failed += 1;
  }
  return {
    total: members.length,
    live: members.length - killed,
    working,
    waiting,
    killed,
    failed,
  };
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

export function tokenizeSwarmInlineText(text: string): SwarmTextToken[] {
  if (!text) return [];
  const out: SwarmTextToken[] = [];
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const start = match.index;
    const raw = match[1]!;
    // Only treat as token at start of line or after non-word char (avoid emails).
    const prevChar = start > 0 ? text[start - 1]! : "";
    if (prevChar && /[A-Za-z0-9_.-]/.test(prevChar)) continue;
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
