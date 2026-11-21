/**
 * 会话按轮切分与人话标题/步骤摘要清洗(OCV5-372 / OCV5-834)。
 *
 * user 消息开启新轮(与 collectPaneSteps 同口径),但**不**丢掉没有工具的轮:只回答了一段话的
 * 轮也是一轮,产出页要能翻到它。
 * 同时提供系统回调轮次标题人话化与宿主桥接命令噪音清洗，供右栏 Workbench 产出/过程页共用。
 */
import type { ChatMessage } from "../../lib/chat/model";

export type WorkTurn = {
  /** 本轮 user 消息 id;会话开头没有 user 消息的那段为 "start"。 */
  key: string;
  title: string;
  /** 本轮 user 消息之后的全部行。 */
  rows: ChatMessage[];
  /** 本轮的顶层工具调用。 */
  steps: ChatMessage[];
  startedAt?: number;
};

const SYSTEM_ENVELOPE_RE =
  /^\[(?:Message|swarm|quota)\]\s*(?:timestamp=\S+\s*)?(?:sender=\S+\s*)?(?:priority=\S+\s*)?(?:content=)?/i;
const LEADING_NOISE_EMOJI_RE = /^(?:[🎫🚨⚠️✅❌🔔📣🤖🚀📌🔴🟢🟡⚡🛠️🧪📦]+\uFE0F?\s*)+/u;
const LEASE_ID_RE = /\blease\s+ls-[A-Za-z0-9-]+\b|\bls-\d{8}T\d{6}Z-[0-9a-f]{6,}\b/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX_RE = /\b(?:origin\s+tip\s+)?[0-9a-f]{10,64}\b/gi;

/** 将原始轮次首句清洗为人话单行标题：识别发版/lease 回调并剥离 emoji / lease id / 长 hex 噪音。 */
export function formatWorkTurnTitle(raw: string | undefined, max = 80): string {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "（无文字的消息）";

  // 1. 系统发版列车 / lease 回调 → 简明中文标题
  if (/\blease\s+ls-[A-Za-z0-9-]+/i.test(line) || /\bls-\d{8}T\d{6}Z-[0-9a-f]{6,}\b/i.test(line)) {
    if (/已满足|切流完成|上线完成|已上线|succeeded|satisfied|completed|passed/i.test(line)) {
      return "发布上线完成";
    }
    if (/失败|未切流|超时|中止|回滚|failed|aborted|expired|rejected|error/i.test(line)) {
      return "发布列车未切流";
    }
    return "发布列车状态通知";
  }
  if (/发版主工作树无法快进|无法快进到\s*origin|fast-forward/i.test(line)) {
    return "发版同步提示";
  }

  // 2. 剥离系统信封、前导告警 emoji、原始 lease id / UUID / 长 commit hex
  let cleaned = line
    .replace(SYSTEM_ENVELOPE_RE, "")
    .replace(LEADING_NOISE_EMOJI_RE, "")
    .replace(LEASE_ID_RE, "")
    .replace(UUID_RE, "")
    .replace(LONG_HEX_RE, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:：,，;；\-—·]+/, "")
    .replace(/[\s\-—·]+$/, "")
    .trim();

  if (!cleaned) cleaned = line;
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

const SHELL_TOOLS = new Set(["Bash", "Shell", "run_terminal_command", "run_terminal_cmd"]);
const HOST_BRIDGE_QUOTED_RE =
  /^\s*(?:env\s+(?:[A-Za-z_]\w*=\S+\s+)*)?(?:\/\S+\/)?host\s+(['"])([\s\S]*?)\1\s*$/;
const HOST_BRIDGE_PREFIX_RE =
  /^\s*(?:env\s+(?:[A-Za-z_]\w*=\S+\s+)*)?(?:\/\S+\/)?host\b\s*['"]?/;
const SHELL_WRAPPER_RE =
  /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|a|da|k)?sh\s+-(?:[a-z]*c)\s+(['"])([\s\S]*?)\1\s*$/;
const BOILERPLATE_LINE_RE =
  /^(?:set\s+-[a-zA-Z]+(?:\s+-o\s+\S+)*|shopt\s+.*|export\s+(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s*)+|cd\s+\S+|#.*|['"])$/;
const HOST_WORKSPACE_PREFIX_RE =
  /\/var\/lib\/docker\/volumes\/[^/\s]+\/_data\/workspace\/(?:[^/\s]+\/)?|\/home\/agent\/\.openclaude\/workspace\/(?:sessions\/[^/\s]+\/)?/g;
const RAW_SHELL_NOISE_RE =
  /^\s*(?:env\s+[A-Za-z_]\w*=|export\s+GIT_CONFIG_|set\s+-[a-z]*[euo]|\/home\/agent\/\.local\/bin\/host\b)/;

function clipLine(text: string, max = 64): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanSingleCommandLine(rawLine: string): string {
  let line = rawLine.trim();
  // 剥离行首 env VAR=... 前缀
  line = line.replace(/^env\s+(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  // 剥离行首独立环境变量赋值（如 GIT_CONFIG_COUNT=1 ...）
  line = line.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S+)\s+)+(?=\S)/, "");
  // 简化工具二进制路径（../../node_modules/.bin/vitest → vitest，/usr/local/bin/npx → npx）
  line = line.replace(/^(?:\.\.\/)*node_modules\/\.bin\//, "");
  line = line.replace(/^\/(?:usr\/local\/bin|usr\/bin|bin|home\/agent\/\.local\/bin)\//, "");
  // 简化宿主机/容器工作区长路径
  line = line.replace(HOST_WORKSPACE_PREFIX_RE, "");
  return line.replace(/\s+/g, " ").trim();
}

function extractMeaningfulShellSummary(rawCmd: string): string {
  let cmd = rawCmd.trim();
  if (!cmd) return "";

  const shellWrap = SHELL_WRAPPER_RE.exec(cmd);
  if (shellWrap?.[2]) cmd = shellWrap[2].trim();

  const hostQuoted = HOST_BRIDGE_QUOTED_RE.exec(cmd);
  if (hostQuoted?.[2]) {
    cmd = hostQuoted[2].trim();
  } else if (HOST_BRIDGE_PREFIX_RE.test(cmd)) {
    cmd = cmd.replace(HOST_BRIDGE_PREFIX_RE, "").replace(/['"]\s*$/, "").trim();
  }

  // 按换行拆分，跳过 set -euo pipefail / export GIT_CONFIG_* / cd ... 等样板行
  const lines = cmd
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    // 处理单行 `cd /foo && export ... && actual_cmd` 链式拼接
    const segments = rawLine.split(/\s*(?:&&|;)\s*/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      if (BOILERPLATE_LINE_RE.test(seg)) continue;
      const cleaned = cleanSingleCommandLine(seg);
      if (!cleaned || BOILERPLATE_LINE_RE.test(cleaned) || RAW_SHELL_NOISE_RE.test(cleaned)) continue;
      return clipLine(cleaned, 64);
    }
  }

  // 若全是 cd / export 样板，尝试提取工单号或回退到友好提示
  const ticket = /\b[A-Z]{2,8}-\d{2,6}\b/.exec(rawCmd)?.[0];
  if (ticket) return `宿主机操作 · ${ticket}`;
  return HOST_BRIDGE_PREFIX_RE.test(rawCmd) ? "宿主机命令" : "";
}

/**
 * 清洗步骤列表行副摘要：
 *  1. 优先使用人话 `toolSummary` / `description`；
 *  2. 对 Bash/Shell 自动剥离 `env HOME=... /home/agent/.local/bin/host '...'`、`set -euo pipefail`、
 *     `export GIT_CONFIG_COUNT=...` 等宿主桥接样板，绝不把内部环境变量代码直接甩在列表行上。
 */
export function formatStepSummary(
  name: string,
  input: Record<string, unknown> | null,
  rawSummary: string,
): string {
  const explicitSummary =
    typeof input?.toolSummary === "string" ? input.toolSummary.trim() : "";
  if (explicitSummary && !RAW_SHELL_NOISE_RE.test(explicitSummary)) {
    return clipLine(explicitSummary, 64);
  }
  const description =
    typeof input?.description === "string" ? input.description.trim() : "";
  if (description && !RAW_SHELL_NOISE_RE.test(description)) {
    return clipLine(description, 64);
  }

  const trimmedRaw = rawSummary.trim();
  if (SHELL_TOOLS.has(name)) {
    const rawCmd = typeof input?.command === "string" ? input.command : "";
    const needsClean =
      RAW_SHELL_NOISE_RE.test(trimmedRaw) ||
      RAW_SHELL_NOISE_RE.test(rawCmd) ||
      /\/home\/agent\/\.local\/bin\/host\b/.test(rawCmd) ||
      /^\s*(?:set\s+-|export\s+|cd\s+\/var\/lib\/docker)/m.test(rawCmd);
    if (needsClean) {
      const cleaned = extractMeaningfulShellSummary(rawCmd || trimmedRaw);
      if (cleaned) return cleaned;
    }
  }

  if (RAW_SHELL_NOISE_RE.test(trimmedRaw)) {
    return extractMeaningfulShellSummary(trimmedRaw) || "执行命令";
  }
  return trimmedRaw;
}

export function collectWorkTurns(messages: readonly ChatMessage[]): WorkTurn[] {
  const turns: WorkTurn[] = [];
  let current: WorkTurn | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (m.status === "queued") continue;
      current = { key: m.id, title: formatWorkTurnTitle(m.text, 80), rows: [], steps: [], startedAt: m.ts };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { key: "start", title: "会话开始", rows: [], steps: [] };
      turns.push(current);
    }
    current.rows.push(m);
    if (m.role === "tool") current.steps.push(m);
  }
  // 还没有任何回应的轮(刚发出)留着:运行中要能看到「这一轮」。开头那段只在有内容时才算。
  return turns.filter((t) => t.key !== "start" || t.rows.length > 0);
}

/** 含这条消息(按 id,回落引用)的那一轮;找不到 → -1。 */
export function turnIndexOf(turns: readonly WorkTurn[], message: { id?: string } | null | undefined): number {
  if (!message) return -1;
  const id = message.id;
  return turns.findIndex((t) => t.key === id || t.rows.some((r) => r === message || (!!id && r.id === id)));
}
