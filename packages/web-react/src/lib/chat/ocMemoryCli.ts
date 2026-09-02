/**
 * 从 Bash/Shell 命令里识别 oc-memory 子命令（与 meta.commandOp 同一套 env 前缀宽容）。
 * 只给 reducer / 卡片展示用：delegate 收成组卡、delegate-wait 绑已有组、空输出运行中文案。
 */

export const SHELL_TOOL_NAMES = new Set([
  "Bash",
  "Shell",
  "run_terminal_command",
  "run_terminal_cmd",
]);

export function isShellToolName(name?: string): boolean {
  return !!name && SHELL_TOOL_NAMES.has(name);
}

/** 与 meta.detectOcCli / commandOp 同一前缀：env 赋值、绝对路径、`cd &&` / 管道 / 换行 / bash -lc 包装内。 */
const OC_MEMORY_OP_RE =
  /(?:^|[\s;&|(\n])(?:\w+=\S*\s+)*(?:\S*\/)?oc-memory\s+([\w-]+)/i;

export function ocMemoryOp(command: string | undefined | null): string {
  if (!command) return "";
  const match = OC_MEMORY_OP_RE.exec(command);
  return (match?.[1] ?? "").toLowerCase();
}

export function parseCliFlag(command: string, flag: string): string {
  const match = new RegExp(
    `(?:^|\\s)--${flag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`,
  ).exec(command);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  if (value.startsWith("--")) return "";
  return value;
}

/** `--goal "$(cat <<'EOF' … EOF)"` / 未加 $() 的 heredoc：取正文（匹配用全文，展示用首行）。 */
export function extractHeredocBody(command: string): string | null {
  const match =
    /<<\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n\2\b/.exec(command) ??
    /<<\s*(['"]?)(\w+)\1\r?\n([\s\S]*?)\r?\n\s*\2\s*\)/.exec(command);
  if (!match) return null;
  return (match[3] ?? "").replace(/\s+$/, "");
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return text.trim();
}

function positionalAfterOp(command: string, op: string): string {
  const re = new RegExp(
    `oc-memory\\s+${op.replace(/-/g, "\\-")}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s"'-][^\\s]*))`,
    "i",
  );
  const match = re.exec(command);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return value.startsWith("--") ? "" : value;
}

export type OcMemoryDelegateParse = {
  op: string;
  /** 展示用：heredoc 取首行，其余取 --goal / 位置参数。 */
  goalRaw: string;
  /** 绑定用：heredoc 用全文（截 1024 由调用方 normalize）。 */
  goalFull: string;
  agentId: string;
  model: string;
  jobId: string;
};

export function parseOcMemoryCommand(command: string | undefined | null): OcMemoryDelegateParse | null {
  const op = ocMemoryOp(command);
  if (!op) return null;
  const text = command || "";
  const heredoc = extractHeredocBody(text);
  const flagGoal = parseCliFlag(text, "goal");
  const goalSource =
    heredoc ||
    (flagGoal.startsWith("$(") ? heredoc || "" : flagGoal) ||
    (op === "delegate" ? positionalAfterOp(text, op) : "");
  const goalFull = goalSource.trim();
  const goalRaw = firstNonEmptyLine(goalFull);
  const jobId =
    parseCliFlag(text, "job-id") ||
    (op === "delegate-wait" ? positionalAfterOp(text, op) : "");
  return {
    op,
    goalRaw,
    goalFull,
    agentId: parseCliFlag(text, "agent-id") || "main",
    model: parseCliFlag(text, "model"),
    jobId,
  };
}

/** 只认动词 `delegate`，不认 delegate-wait / delegate_tasks 等。 */
export function isOcMemoryDelegateVerb(command: string | undefined | null): boolean {
  return ocMemoryOp(command) === "delegate";
}

export function isOcMemoryDelegateWait(command: string | undefined | null): boolean {
  return ocMemoryOp(command) === "delegate-wait";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** Cursor 后台挂起 / 仍在跑 的可见信号（剥壳前的原文也要认）。 */
export function hasDelegateBackgroundSignal(output?: string | null): boolean {
  if (!output) return false;
  if (/process is still running|moved to background/i.test(output)) return true;
  if (/(?:^|[\s,;])status=running(?:\s|$)/i.test(output)) return true;
  if (/isBackground["']?\s*[:=]\s*true/i.test(output)) return true;
  const parsed = parseJsonObject(output);
  if (!parsed) return false;
  if (parsed.isBackground === true || parsed.status === "running") return true;
  const success = asRecord(parsed.success);
  if (success) {
    const stdout = typeof success.stdout === "string" ? success.stdout : "";
    const stderr = typeof success.stderr === "string" ? success.stderr : "";
    if (/process is still running|moved to background/i.test(`${stdout}\n${stderr}`)) return true;
  }
  return false;
}

/**
 * oc-memory delegate 空输出且未完成、或带后台/仍在跑信号 → 展示「委派运行中…」
 * 而不是「操作已完成。」
 */
export function shouldShowDelegateRunning(opts: {
  command?: string | null;
  output?: string | null;
  completed?: boolean;
  stripped?: string;
}): boolean {
  if (!isOcMemoryDelegateVerb(opts.command)) return false;
  if (hasDelegateBackgroundSignal(opts.output) || hasDelegateBackgroundSignal(opts.stripped)) {
    return true;
  }
  const empty = !(opts.stripped ?? opts.output ?? "").trim();
  return empty && opts.completed !== true;
}
