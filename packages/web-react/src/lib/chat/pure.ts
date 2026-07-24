/**
 * v5 WS 消费侧**纯函数 + 常量**——零 DOM、零 React、零 timer。
 *
 * 这些全部从现网 vanilla 权威蓝本逐条复刻（行号默认指
 * packages/web/public/modules/websocket.js，emptyTurn.js / partialJson.js /
 * state.js 已单独标注）。它们是 parity 验收的天然测试锚点：现网每个都有对应单测，
 * 漏掉/改坏任一个 = 重现一类历史已修 bug。
 */
import {
  EXPECTED_TURN_ERROR_CODES,
  isDisplayableServerMessage,
  isKnownTurnErrorCode,
  normalizeTurnErrorCode,
  REPORT_EXEMPT_TURN_ERROR_CODES,
  type TurnErrorCode,
  turnErrorSemantics,
} from "@openclaude/protocol";
import type {
  OutboundContentBlock,
  OutboundMessageWire,
} from "./frames";

// ═══════════════ 常量 ═══════════════

/** safeWsSend 背压上限（websocket.js:122）。2MB ≈ 128 条已排队 prompt。*/
export const SAFE_WS_BUFFER_BYTES = 2 * 1024 * 1024;
/** app-level close code：背压/发送失败主动断开自愈（websocket.js:123）。*/
export const WS_CLOSE_CODE_STALLED = 4000;
/** keepalive 探活超时主动断（websocket.js:184）。*/
export const WS_CLOSE_CODE_KEEPALIVE = 4001;

/** offline 事件迟到确认窗口（websocket.js:66）。*/
export const OFFLINE_LATCH_GRACE_MS = 60_000;
/** visibility 触发立即重连的去抖（websocket.js:70）。*/
export const VISIBILITY_RECONNECT_COOLDOWN_MS = 2000;
/** ping 探活超时（websocket.js:87-88）。切回前台的探活收紧到 1.5s：移动端锁屏后 WS 常
 *  变"看似 OPEN 实则死链",5s 才发现太慢、超时定时器可能抢先误报；1.5s 内无 pong 即 close
 *  自愈重连（健康连接 pong 立刻返回、无副作用），是比"每次切回都强制重连"风险更低的选择。*/
export const PROBE_TIMEOUT_VISIBILITY_MS = 1500;
export const PROBE_TIMEOUT_KEEPALIVE_MS = 10000;
/** 连接"确认存活"窗口：最近这段时间内收到过 pong 或任意帧即视为链路仍活。thinking-safety
 *  超时判定据此分流——未确认存活=静默死链→强制重连而非误报本轮超时（见 socket.resetThinkingSafety）。*/
export const LIVENESS_CONFIRM_MS = 45_000;
/** REST 对账去抖：同一会话 5s 内至多触发一次 syncSession（切回前台/重连成功都会打）。*/
export const SYNC_DEBOUNCE_MS = 5000;
/** "近期有过 in-flight"的会话窗口：切回/重连时对账这些会话，追回锁屏期静默丢失的帧。*/
export const RECENT_INFLIGHT_WINDOW_MS = 15 * 60_000;
/** keepalive 心跳间隔（websocket.js:2113）。*/
export const KEEPALIVE_INTERVAL_MS = 30_000;
/** THINKING_SAFETY 兜底：10min 无新帧才杀 turn（websocket.js:274）。*/
export const THINKING_SAFETY_MS = 10 * 60_000;
/** reconcile 'turn_state_unknown' 后临时缩短的 thinking-safety 复检间隔(RFC §4)：server 无法
 *  判定在飞 turn 终态时,把默认 10min 首窗降到 60s,尽快 REST 复检拉回终态/error projection。*/
export const TURN_STATE_UNKNOWN_SAFETY_MS = 60_000;
/** 重连后等 replay 先赢，再 REST reconcile 的 grace（websocket.js:284）。*/
export const RECONNECT_RECONCILE_GRACE_MS = 4000;
/** reconnect 后延迟启动 drain，让 hello/resume isFinal 先到（websocket.js:2104）。*/
/** drain 单条 isFinal 安全网（不再当失败判定，只提示，websocket.js:1411）。*/
export const DRAIN_ISFINAL_SAFETY_MS = 120_000;

/** offlineQueue 软上限（state.js:145）。*/
export const MAX_OFFLINE_QUEUE = 200;

/** cost_charged 晚到归因 TTL（websocket.js:3700）。*/
export const COST_CHARGED_LAST_FINAL_TTL_MS = 60_000;

// stale 状态机阈值（typing-indicator 升级文案用）。
export const STALE_GENERATING_MS = 12_000;
export const STALE_WARN_MS = 30_000;
export const STALE_DANGER_MS = 90_000;

// ═══════════════ partialJson offset 累加器（websocket.js:654-666）═══════════════

export type PartialJsonDeltaResult =
  | { action: "set"; value: string }
  | { action: "drop" }
  | { action: "keep" };

/**
 * append-only delta 协议（frames.ts:166-229，v1.0.167+）：校验
 * `offset === 当前累加器长度`。命中→append；不命中（dup/乱序/ring replay 重叠/
 * late-join）→ drop 整个 buffer，让渲染回退 inputPreview，等 final inputJson 重绘
 * 真相（无数据丢失）。recovery 无状态：drop 后一个 offset===0 帧会重新 seed。
 */
export function applyPartialJsonDelta(
  current: string | null | undefined,
  block: { partialJsonDelta?: unknown; partialJsonOffset?: unknown },
): PartialJsonDeltaResult {
  if (
    typeof block.partialJsonDelta !== "string" ||
    typeof block.partialJsonOffset !== "number"
  ) {
    return { action: "keep" };
  }
  const cur = current || "";
  if (block.partialJsonOffset === cur.length) {
    return { action: "set", value: cur + block.partialJsonDelta };
  }
  return { action: "drop" };
}

// ═══════════════ 容错 partial JSON 解析（partialJson.js）═══════════════

const WS_RE = /\s/;

type ScanString = { value: string; end: number; partial: boolean } | null;

function scanString(s: string, i: number): ScanString {
  if (s[i] !== '"') return null;
  let j = i + 1;
  let out = "";
  while (j < s.length) {
    const c = s[j];
    if (c === '"') return { value: out, end: j + 1, partial: false };
    if (c === "\\") {
      if (j + 1 >= s.length) return { value: out, end: s.length, partial: true };
      const esc = s[j + 1];
      if (esc === '"') { out += '"'; j += 2; }
      else if (esc === "\\") { out += "\\"; j += 2; }
      else if (esc === "/") { out += "/"; j += 2; }
      else if (esc === "b") { out += "\b"; j += 2; }
      else if (esc === "f") { out += "\f"; j += 2; }
      else if (esc === "n") { out += "\n"; j += 2; }
      else if (esc === "r") { out += "\r"; j += 2; }
      else if (esc === "t") { out += "\t"; j += 2; }
      else if (esc === "u") {
        if (j + 6 > s.length) return { value: out, end: s.length, partial: true };
        const hex = s.slice(j + 2, j + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, end: s.length, partial: true };
        out += String.fromCharCode(parseInt(hex, 16));
        j += 6;
      } else {
        out += c + esc;
        j += 2;
      }
    } else {
      out += c;
      j++;
    }
  }
  return { value: out, end: s.length, partial: true };
}

function scanBalanced(s: string, i: number): number {
  const open = s[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return -1;
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"') {
      const sr = scanString(s, j);
      if (!sr) return -1;
      if (sr.partial) return -1;
      j = sr.end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * 容错解析半截 tool_use input JSON（Edit/Write 逐字流式驱动）。顶层非 object→{}；
 * 只提取已完整字段 + 当前正在打的字符串尾；**永不抛**（partialJson.js）。
 */
export function parsePartialJson(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || s.length === 0) return {};
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    /* fall through */
  }
  let i = 0;
  while (i < s.length && WS_RE.test(s[i])) i++;
  if (s[i] !== "{") return {};
  i++;
  const out: Record<string, unknown> = {};
  while (i < s.length) {
    while (i < s.length && (WS_RE.test(s[i]) || s[i] === ",")) i++;
    if (i >= s.length) break;
    if (s[i] === "}") break;
    if (s[i] !== '"') break;
    const keyResult = scanString(s, i);
    if (!keyResult || keyResult.partial) break;
    const key = keyResult.value;
    i = keyResult.end;
    while (i < s.length && WS_RE.test(s[i])) i++;
    if (s[i] !== ":") break;
    i++;
    while (i < s.length && WS_RE.test(s[i])) i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === '"') {
      const v = scanString(s, i);
      if (!v) break;
      out[key] = v.value;
      i = v.end;
      if (v.partial) break;
    } else if (ch === "{" || ch === "[") {
      const end = scanBalanced(s, i);
      if (end === -1) break;
      try {
        out[key] = JSON.parse(s.slice(i, end));
      } catch {
        /* skip field */
      }
      i = end;
    } else {
      const start = i;
      while (i < s.length && s[i] !== "," && s[i] !== "}" && !WS_RE.test(s[i])) i++;
      if (i >= s.length) break;
      const token = s.slice(start, i);
      if (token === "true") out[key] = true;
      else if (token === "false") out[key] = false;
      else if (token === "null") out[key] = null;
      else if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
        const n = Number(token);
        if (Number.isFinite(n)) out[key] = n;
      }
    }
  }
  return out;
}

// ═══════════════ frameSeq 去重（per-sessionKey 游标，websocket.js:2510-2557）═══════════════

/** 帧的 frameSeq 游标 key：优先 sessionKey，否则回退 `peer:<sessId>`。*/
export function frameSeqKey(frame: { sessionKey?: string }, sessId: string | undefined): string {
  return typeof frame?.sessionKey === "string" && frame.sessionKey
    ? frame.sessionKey
    : `peer:${sessId || ""}`;
}

/** agent-scoped sessionKey 构造（hello peer + 去重一致）。*/
export function safeSessionKeyForAgent(sessId: string | undefined, agentId: string): string {
  const safeId = String(sessId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `agent:${agentId}:webchat:dm:${safeId}`;
}

/**
 * 读游标：byKey 命中即用；未命中时**只有 `peer:` 前缀才回退 legacy 单游标**，
 * agent-scoped key 一律从 0 起（严禁全局单游标污染多容器并行流，websocket.js:2522）。
 */
export function getFrameSeqCursor(
  byKey: Record<string, number> | undefined,
  legacyLast: number | undefined,
  key: string,
): number {
  if (byKey && typeof byKey === "object" && Number.isFinite(byKey[key])) return byKey[key];
  return key && key.startsWith("peer:") ? legacyLast || 0 : 0;
}

// ═══════════════ 空轮分类（emptyTurn.js）═══════════════

export const EMPTY_TURN_ANSWER_ROLES = new Set([
  "assistant", "tool", "agent-group", "delegate-progress", "plan", "goal", "permission",
]);

/** isFinal 前的快速 lookahead 白名单：thinking 不算 answer（GLM “想了没说” bug）。*/
export const ANSWER_BLOCK_KINDS = new Set(["text", "tool_use", "plan", "goal"]);

export function countAnswerBlocks(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0;
  let n = 0;
  for (const b of blocks) if (b && ANSWER_BLOCK_KINDS.has((b as { kind?: string }).kind ?? "")) n++;
  return n;
}

export function emptyTurnNoticeText(
  stopReason: string | undefined | null,
  priorTurnHadContent: boolean,
): string {
  switch (stopReason) {
    case "end_turn":
      return "模型本轮主动结束(通常表示它判断不需要再回复或上下文已表达完整)。可继续追问。";
    case "pause_turn":
      return "模型暂停了本轮(通常因长任务超时),可直接重新发送让它继续。";
    case "max_tokens":
      return '本轮输出达到 token 上限,内容可能不完整。可让它"继续"。';
    case "refusal":
      return "模型拒绝回复本轮内容。";
    case "tool_use":
      return "工具调用流意外中断,请重试。";
    case "stop_sequence":
      return "模型命中停止序列结束本轮。";
    default:
      if (stopReason) return `模型本轮无内容输出 (stop_reason=${stopReason})。可重试或继续追问。`;
      if (priorTurnHadContent) return "模型本轮未输出新内容,可继续追问或重新提问。";
      return "未收到回复 — 服务端标记已完成,但没有生成任何内容。请重试。";
  }
}

export type EmptyTurnMsg = { id?: string; role?: string };

export type EmptyTurnDecision =
  | { insert: false }
  | { insert: true; text: string; soft: boolean; stopReason: string | null };

/**
 * isFinal 且无 answer-bearing 消息（thinking 不算）→ 插一条非告警 notice。
 * **必须在 block 渲染后才分类**（消费侧 deferred 到 isFinal block 之后）。
 */
export function classifyEmptyTurn(p: {
  messages: EmptyTurnMsg[];
  targetMsgId: string;
  hasAnswerOutput: boolean;
  stopReason?: string | null;
}): EmptyTurnDecision {
  const { messages, targetMsgId, hasAnswerOutput, stopReason } = p;
  if (hasAnswerOutput) return { insert: false };
  if (!Array.isArray(messages)) return { insert: false };
  const targetIdx = messages.findIndex((m) => m && m.id === targetMsgId);
  if (targetIdx < 0) return { insert: false };
  for (let i = targetIdx + 1; i < messages.length; i++) {
    if (EMPTY_TURN_ANSWER_ROLES.has(messages[i]?.role ?? "")) return { insert: false };
  }
  let priorTurnHadContent = false;
  for (let i = targetIdx - 1; i >= 0; i--) {
    const r = messages[i]?.role;
    if (r === "user") break;
    if (r === "thinking" || EMPTY_TURN_ANSWER_ROLES.has(r ?? "")) {
      priorTurnHadContent = true;
      break;
    }
  }
  return {
    insert: true,
    text: emptyTurnNoticeText(stopReason, priorTurnHadContent),
    soft: priorTurnHadContent || !!stopReason,
    stopReason: stopReason ?? null,
  };
}

export const AUTO_CONTINUE_PROMPT = "请基于刚才的思考,继续输出完整的正文回答。";
export const AUTO_CONTINUE_DISPLAY = "↻ 自动续写";
/** 服务重启把上游生成流掐断(容器模型调用经 master 内部代理)时的自动续写。 */
export const RESTART_CONTINUE_PROMPT =
  "你上一条回复因服务重启被中断。请从中断处继续输出剩余内容,不要重复已经输出的部分,直接接着写。";
export const RESTART_CONTINUE_DISPLAY = "↻ 服务重启中断,自动续写";
export const INTERRUPTED_CONTINUE_PROMPT =
  "继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续；不要重新执行已经完成的步骤，不要重复已经输出的内容。若外部写操作的结果仍不明确，不得重复提交，先核对状态或向用户说明。";
export const INTERRUPTED_CONTINUE_DISPLAY = "↻ 从断点继续";
export const AUTOMATIC_RECOVERY_CHECKPOINT_DISPLAY = "↻ 自动从断点继续";
export const AUTOMATIC_RECOVERY_REPLAY_DISPLAY = "↻ 自动重试";

export function isAutoContinueMsg(m: {
  _isAutoRetry?: boolean;
  _modelText?: string;
  text?: string;
} | null | undefined): boolean {
  return !!(
    m &&
    (m._isAutoRetry === true ||
      m._modelText === AUTO_CONTINUE_PROMPT ||
      m.text === AUTO_CONTINUE_DISPLAY)
  );
}

/**
 * 是否对空轮自动续写（vs 仅提示）。仅 `end_turn`；每原始 turn 至多一次
 * （target 本身是 auto-continue / 已跟随一条 auto-continue user 都拒）。
 */
export function shouldAutoContinueEmptyTurn(p: {
  messages: Array<{ id?: string; role?: string; _isAutoRetry?: boolean; _modelText?: string; text?: string }>;
  targetMsgId: string;
  stopReason?: string | null;
}): boolean {
  const { messages, targetMsgId, stopReason } = p;
  if (stopReason !== "end_turn") return false;
  if (!Array.isArray(messages)) return false;
  const idx = messages.findIndex((m) => m && m.id === targetMsgId);
  if (idx < 0) return false;
  if (isAutoContinueMsg(messages[idx])) return false;
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i]?.role === "user" && isAutoContinueMsg(messages[i])) return false;
  }
  return true;
}

// ═══════════════ 归档 / 上下文重建文案（SESSION_ARCHIVE_DESIGN §5,统一权威）═══════════════

/**
 * 上下文重建 system 提示行文案(引擎无法原生续接、走兜底注入历史时)。`n` = 注入的对话条数。
 * 文案严格取自设计合同 §5,四个 agent 共用同一源,勿各写各的。
 */
export function contextRebuiltNotice(n: number): string {
  return `已重新加载会话上下文(最近 ${n} 条对话摘要)。更早的细节助手可能记不全,如需引用旧内容可直接粘贴。`;
}

/** "从云端加载更早的历史"按钮文案。`remaining` = 归档中尚未拉取的条数。设计合同 §5。 */
export function loadOlderHistoryLabel(remaining: number): string {
  return `从云端加载更早的历史(还有 ${remaining} 条)`;
}

// ═══════════════ 状态文案（onopen / typing）═══════════════

/** onopen 初始 status pill：队列非空显 “补发离线消息…(N)”，不能直接显 “已连接”。*/
export function onopenSetInitialStatus(offlineQueueLen: number): [string, ChatStatusClass] {
  if (offlineQueueLen > 0) return [`补发离线消息… (${offlineQueueLen})`, "connecting"];
  return ["已连接", "connected"];
}

export type ChatStatusClass = "connected" | "connecting" | "disconnected";

export function computeTypingLabel(p: {
  name: string;
  secs: number;
  silenceMs: number;
  turnStatus?: string | null;
  hint?: string;
}): { text: string; cls: string } {
  const { name, secs, silenceMs, turnStatus, hint = "" } = p;
  if (turnStatus === "compacting") {
    return { text: `${name} 正在压缩上下文 (${secs}s)`, cls: "compacting" };
  }
  if (silenceMs >= STALE_DANGER_MS) {
    const sil = Math.round(silenceMs / 1000);
    return { text: `${name} 处理时间较长,仍在思考中 (${secs}s · ${sil}s 无新数据)`, cls: "stale-danger" };
  }
  if (silenceMs >= STALE_WARN_MS) {
    const sil = Math.round(silenceMs / 1000);
    return { text: `${name} 深度思考中 (${secs}s · ${sil}s 无新数据)`, cls: "stale-warn" };
  }
  if (silenceMs >= STALE_GENERATING_MS) {
    return { text: `${name} 正在生成内容,请稍候 (${secs}s)`, cls: "generating" };
  }
  if (secs >= 5) return { text: `${name} 思考中 (${secs}s)${hint}`, cls: "" };
  return { text: `${name} 思考中${hint}`, cls: "" };
}

// ═══════════════ close code 语义（websocket.js:190-217, 2253-2316）═══════════════

export type ParsedCloseReason = { raw: string; reason?: string; retryAfterSec?: number };

export function parseWsCloseReason(reason: unknown): ParsedCloseReason {
  if (typeof reason !== "string" || !reason) return { raw: "" };
  try {
    const parsed = JSON.parse(reason);
    if (parsed && typeof parsed === "object") {
      return {
        raw: reason,
        reason: String(parsed.reason || ""),
        retryAfterSec: Number(parsed.retryAfterSec) || 0,
      };
    }
  } catch {
    /* not JSON */
  }
  return { raw: reason, reason };
}

export type NonAuthPolicyInfo = {
  status: string;
  toast: string;
  /** 余额不足：toast 用 warning + 触发 refreshBalance。*/
  billing?: boolean;
};

/** 非鉴权策略类 close（4505/4506/4507/4508）→ 文案 + 排程重连（websocket.js:201）。*/
export function nonAuthPolicyCloseInfo(code: number, reason: unknown): NonAuthPolicyInfo | null {
  const parsed = parseWsCloseReason(reason);
  const r = parsed.reason || parsed.raw || "";
  if (code === 4505 || r === "kicked" || r === "too_many_connections") {
    return { status: "连接数超限", toast: "连接数已达上限，请关闭其他标签页或设备后再试。" };
  }
  if (code === 4506 || r === "insufficient_credits") {
    return { status: "余额不足", toast: "余额不足，请充值后继续。", billing: true };
  }
  if (code === 4507 || r === "unauthorized_model") {
    return { status: "模型未开通", toast: "当前账号尚未开通该模型，请切换模型或联系管理员。" };
  }
  // 4508 codex_container_recycled v5 已删 codex；保留兜底不会出错。
  if (code === 4508 || r === "codex_container_recycled") {
    return { status: "环境已重建", toast: "环境已重建，请刷新页面后重发。" };
  }
  return null;
}

const PROVISIONING_REASONS = new Set(["provisioning", "starting"]);
const CLOSE_REASON_LABELS: Record<string, string> = {
  // provisioning/starting 也进表:4503 时 `provisioning` 布尔已置(App 三态优先命中「环境启动中」),
  // 但 4504 携同 reason 不置 provisioning 布尔(见下方 code===4503 门控),补此二项保证 4504
  // 供给类 close 的 status.label 也有可读文案,不落裸倒计时。
  provisioning: "环境启动中，正在为你准备工作区",
  starting: "环境启动中，正在为你准备工作区",
  // 4509 服务重启/发版(CLOSE_BRIDGE.SERVER_RESTART):瞬态,自动重连+resume 续传,
  // 只在连接横幅露出,不进会话正文。
  server_restart: "服务更新中，正在自动重连…",
  host_full: "资源繁忙，正在排队重试",
  migration_in_progress: "环境迁移中，稍后自动重试",
  image_missing: "运行镜像未就绪，管理员处理中",
  image_outdated: "运行镜像更新中，稍后自动重试",
  baseline_missing: "基础环境未就绪，管理员处理中",
  data_host_unavailable: "数据节点暂不可用，正在保护你的工作区",
  supervisor_error: "环境启动异常，稍后自动重试",
};

export type CloseDecision = {
  /** 'auth_1008' | 'policy' | 'offline_wait' | 'reconnect'。*/
  action: "auth_1008" | "policy" | "reconnect";
  policy?: NonAuthPolicyInfo;
  /** reconnect 专用：server hint 延迟（>0 时不增 attempts）。*/
  serverHintedDelay: number;
  /** 4503 provisioning → 显 banner。*/
  provisioning: boolean;
  /** CLOSE_REASON_LABELS 命中文案（4503/4504 错误类 reason）。*/
  closeReasonLabel: string;
};

/**
 * onclose 分类（**12 分钟死循环 bug 根治**：4503/4504 必须读 retryAfterSec 并
 * clamp [1s,60s]，不能走纯指数退避，websocket.js:2253）。1008 走续期；4505-4508
 * 走 policy；其余走标准退避。这里只做**决策**，不碰 ws / timer（service 据此驱动）。
 */
export function classifyClose(code: number, reason: unknown): CloseDecision {
  const policy = nonAuthPolicyCloseInfo(code, reason);
  if (policy) return { action: "policy", policy, serverHintedDelay: 0, provisioning: false, closeReasonLabel: "" };
  if (code === 1008) return { action: "auth_1008", serverHintedDelay: 0, provisioning: false, closeReasonLabel: "" };
  // 4509 服务重启/发版(服务端 CLOSE_BRIDGE.SERVER_RESTART,两端语义务必同改):瞬态,
  // 走标准退避立即自动重连(蓝绿重启秒级),横幅露「服务更新中」;绝不弹错/不进正文。
  if (code === 4509) {
    return {
      action: "reconnect",
      serverHintedDelay: 0,
      provisioning: false,
      closeReasonLabel: CLOSE_REASON_LABELS.server_restart,
    };
  }

  let serverHintedDelay = 0;
  let provisioning = false;
  let closeReasonLabel = "";
  if ((code === 4503 || code === 4504) && typeof reason === "string" && reason.length > 0) {
    try {
      const parsed = JSON.parse(reason);
      const sec = parsed?.retryAfterSec;
      if (Number.isFinite(sec) && sec > 0) {
        const clamped = Math.min(Math.max(sec * 1000, 1000), 60_000);
        serverHintedDelay = clamped + Math.random() * 500;
      }
      if (code === 4503 && PROVISIONING_REASONS.has(parsed?.reason)) provisioning = true;
      if (typeof parsed?.reason === "string" && CLOSE_REASON_LABELS[parsed.reason]) {
        closeReasonLabel = CLOSE_REASON_LABELS[parsed.reason];
      }
    } catch {
      /* fallback backoff */
    }
  }
  return { action: "reconnect", serverHintedDelay, provisioning, closeReasonLabel };
}

/** 弱网/重连状态条的三态文案（单一权威，抽纯函数便于单测锁定）。优先级：
 *   1. `!browserOnline` → 「网络已断开」：明确归因用户侧断网（非服务端故障），不显倒计时（联网即自动重连）；
 *   2. `provisioning`（4503 provisioning/starting）→ 「环境启动中」：首次开机 / 唤醒等待，非故障；
 *   3. 其余未连接 → 直接呈现 `label`（socket 已把 closeReasonLabel + 倒计时组装进 status.label）。
 *  `cls === "connected"` 返回 null（不显条）。tone 贴 Alert：disconnected=warning，connecting=info。*/
export type ConnBanner = { tone: "info" | "warning"; text: string } | null;
export function deriveConnBanner(input: {
  cls: ChatStatusClass;
  label: string;
  browserOnline: boolean;
  provisioning: boolean;
}): ConnBanner {
  if (input.cls === "connected") return null;
  if (!input.browserOnline) return { tone: "warning", text: "网络已断开，恢复后自动重连" };
  if (input.provisioning) return { tone: "info", text: "环境启动中，正在为你准备工作区…" };
  return { tone: input.cls === "disconnected" ? "warning" : "info", text: input.label };
}

/** 标准指数退避 + jitter（websocket.js:2313）：2/4/8/16/30s 上限 + 0–1000ms。*/
export function backoffDelay(attempts: number): number {
  return Math.min(2000 * 2 ** attempts, 30000) + Math.random() * 1000;
}

// ═══════════════ bridge error 归一化（websocket.js:3906-3935）═══════════════

/**
 * 归一化任意来源错误码 → 语义码。**薄包装 protocol normalizeTurnErrorCode**(单一权威:
 * 大写 legacy 控制码走 LEGACY_CODE_ALIASES、其余转小写)。只保留一条前端 only 特判:裸
 * `BACKPRESSURE`(无 ERR_ 前缀)——protocol 只认 `ERR_BACKPRESSURE`,而现网旧 master 曾裸发
 * 该码,归连接态兜旧回滚窗残帧。空值 → 'unknown'(与 protocol 一致)。
 */
export function normalizeBridgeErrorCode(code: unknown): string {
  if (String(code ?? "").trim().toUpperCase() === "BACKPRESSURE") return "conn_kicked";
  return normalizeTurnErrorCode(code);
}

export function isBridgeAuthControlError(code: unknown): boolean {
  return normalizeBridgeErrorCode(code) === "unauthorized";
}

/**
 * 用户向错误正文表 —— **key 集合与 protocol TURN_ERROR_TAXONOMY 对齐**(契约测试 turnErrorTaxonomy
 * .contract 锁死每码有正文,防漂移)。标题在 render.ts ERROR_LABELS(同表另一权威,同源同 key)。
 * 语义(retryable/cta/allowPublicServerMessage)只在 protocol,这里只落中文文案。
 * 合并语义相同的码用同一串(如 authority/catalog 不可用;两 codex_unavailable 别名)。
 */
export const BRIDGE_ERROR_MESSAGES: Record<TurnErrorCode, string> = {
  // ── 计费/配额 ──
  insufficient_credits: "余额不足，充值后即可继续使用。",
  rate_limited: "请求暂时较多，请稍后直接重试本条消息。",
  // ── 上游模型服务 ──
  model_capacity: "当前模型访问量较大，请稍后重试，或在上方切换到其他模型立即继续。",
  upstream_failed: "任务执行暂时中断，你的消息已保留，可直接重试。",
  upstream_timeout: "模型响应超时，你的消息已保留，请重试。",
  network_error: "网络波动导致本轮中断，请重试。",
  context_too_long: "上下文长度超过模型上限，请精简内容或开启新会话。",
  bad_request: "这条请求无法被处理，请调整内容后重试。",
  // ── 引擎/平台执行 ──
  engine_error: "任务执行时遇到内部错误，你的消息已保留，可以直接重试。",
  internal_error: "服务遇到内部错误，你的消息已保留，请重试。",
  auth_error: "认证状态异常，本轮未正常完成，请重新尝试。",
  service_restart: "服务正在更新，本轮已中断，请重试。",
  session_persist_unavailable: "消息已保留在本机，但暂时未能安全送达。请点下方“重试”原样发送。",
  stopped: "本轮生成已停止。",
  user_cancelled: "本轮已取消。",
  runner_crashed: "执行环境意外中断，你的消息已保留，请重试。",
  // ── 免单类(waivable;errorPresentation 走 waiver 分支,此处仅供契约完备 + 兜底展示)──
  model_authority_expired: "长任务的执行凭证未能继续，本轮不收费，你可以重新尝试。",
  liveness_timeout: "任务长时间没有新输出，系统已中断，本轮不收费。",
  idle_timeout: "任务长时间没有新输出，系统已中断，本轮不收费。",
  no_response: "任务未能产生有效回复，本轮未扣费。",
  phantom_turn: "任务未能产生有效回复，本轮未扣费。",
  turn_limit: "任务达到运行上限，系统已中断，本轮不收费。",
  // ── 模型权威 gate 拒帧(方案 §4 R3-m12)──
  model_config_changed_retry_turn:
    "平台的模型配置刚刚更新，本轮已停止（不计费）。你的消息没有丢：点它下方的「重试」即可原样重发。",
  model_not_available: "这个模型当前不可用（已下架或未对你的账号开通），请在上方切换一个模型后重发。",
  unresolved_agent_model: "没能确定本轮要用的模型，请在上方选择模型后重发。",
  model_authority_unavailable: "模型配置正在同步，请稍后点「重试」重发本条消息。",
  model_catalog_unavailable: "模型配置正在同步，请稍后点「重试」重发本条消息。",
  unauthorized_model: "当前账号尚未开通这个模型，请切换模型或联系管理员。",
  // ── 连接/环境 ──
  unauthorized: "登录状态已失效，请重新登录后继续。",
  maintenance: "服务正在维护中，请稍后再试。",
  conn_kicked: "连接曾短暂中断，系统会自动重连并续传，已生成的内容不受影响。",
  // 运行环境已重建:必须**刷新页面**,重试无效(allowPublicServerMessage:服务端 message 指路)。
  container_outdated: "运行环境已更新，请刷新页面后重新发送（直接重试不会生效）。",
  err_container: "运行环境出现异常，你的消息已保留，请重试。",
  err_container_timeout: "运行环境响应超时，请重试。",
  err_internal: "服务遇到内部错误，请重试。",
  forbidden: "该操作被拒绝，请检查后重试。",
  err_frame_too_big: "本轮内容过大无法处理，请精简后重试。",
  bad_json: "收到的数据格式异常，请重试。",
  bad_sequence: "消息时序出现异常，请重试。",
  unknown_control: "收到无法识别的指令，请重试。",
  // ── 媒体/子系统(image_* 白名单可展示服务端 message)──
  image_upstream_rejected: "图片生成/编辑被上游拒绝（可能触发了内容审核），请调整描述或更换图片后重试。",
  image_server_busy: "图片服务当前繁忙，请稍后重试。",
  voice_upstream_error: "语音识别服务暂时不可用，请重试",
  voice_timeout: "语音识别超时，请重试",
  // ── 遗留兼容(新 bridge 不再发射,归一化仍认)──
  codex_turn_busy: "上一轮任务仍在运行，请等它结束后再发送。",
  codex_pool_busy: "账号池繁忙，请稍后重试。",
  codex_route_unavailable: "GPT 服务暂时不可用，你的消息已保留，请稍后重试。",
  codex_container_recycled: "环境已重建，请刷新页面后重发。",
  codex_billing: "计费服务暂时不可用，本轮未开始，请稍后重试。",
  upstream_error: "模型服务暂时不可用，你的消息已保留，请重试。",
};

/** 未知码的通用兜底正文(契约测试据此判定「某码是否漏配正文」)。 */
export const BRIDGE_ERROR_FALLBACK = "系统暂时不可用，请稍后重试。";

export function friendlyBridgeErrorMessage(code: unknown, message?: string): string {
  const n = normalizeBridgeErrorCode(code);
  // 服务端 message 白名单透传(任务①):仅当该码 allowPublicServerMessage===true 且 message 过
  // 展示守卫(≤200 字符、非 JSON/堆栈形态)→ 直显服务端原因(如 container_outdated 的具体指路、
  // image_upstream_rejected 的审核说明);否则一律回按码文案,绝不把裸技术串抛给用户。
  if (typeof message === "string" && isKnownTurnErrorCode(n)) {
    if (turnErrorSemantics(n).allowPublicServerMessage && isDisplayableServerMessage(message)) {
      return message;
    }
  }
  if (isKnownTurnErrorCode(n)) return BRIDGE_ERROR_MESSAGES[n];
  // codex_unavailable 是历史别名(非 taxonomy 码),与 route_unavailable 同义。
  if (n === "codex_unavailable") return BRIDGE_ERROR_MESSAGES.codex_route_unavailable;
  return BRIDGE_ERROR_FALLBACK;
}

/**
 * 「查看详情」只保留可公开的说明与 trace id。上游/路由/账号池原文仍进入错误遥测，
 * 但不能持久化进会话后直接展示给用户。
 */
export function safeBridgeErrorDetail(code: unknown, traceId?: unknown): string {
  const summary = friendlyBridgeErrorMessage(code);
  const trace = typeof traceId === "string" ? traceId.trim() : "";
  return trace ? `${summary}\n请求编号：${trace}` : summary;
}

/**
 * 预期业务态错误码(**展示语义**:对单用户是正常业务分支,非故障)。**从 protocol 单一权威派生**
 * (TURN_ERROR_TAXONOMY 中 expected===true,见 EXPECTED_TURN_ERROR_CODES)。含
 * rate_limited/model_capacity/service_restart/image_server_busy 等"对用户预期、但对平台是运营
 * 信号"的码 —— 它们仍**要进遥测**,故上报口径**不用本集合**,改用下方 REPORT_EXEMPT。
 * ⚠️ 遥测抑制请勿用本集合(那是历史误用,Codex 审计 R5c 已拆分);本集合供展示/交互语义消费。
 */
export const EXPECTED_TURN_ERR_CODES: ReadonlySet<string> = EXPECTED_TURN_ERROR_CODES;

/**
 * **遥测豁免**错误码:reducer 上报 turn_error 时抑制这些码(reportTurnError 不发)。**从 protocol
 * 单一权威派生**(TURN_ERROR_TAXONOMY 中 reportable===false,见 REPORT_EXEMPT_TURN_ERROR_CODES)。
 * **与 expected 解耦**(Codex 审计 R5c 裁定):只有用户主动行为(stopped/user_cancelled)与纯业务
 * 规则拒绝(insufficient_credits/未开通/配置变更/维护/连接踢出/codex_* 遗留)才豁免;
 * rate_limited/model_capacity/service_restart/image_server_busy 恢复上报(平台运营故障信号)。
 */
export const REPORT_EXEMPT_TURN_ERR_CODES: ReadonlySet<string> = REPORT_EXEMPT_TURN_ERROR_CODES;

// ═══════════════ 流式行身份（server canonical id upsert，websocket.js:606）═══════════════

/**
 * 有 messageId 且已存在同 id+role 行→返回它（rebind 流式指针，支持 turn 内
 * text→tool→text 多段同 id）；否则 create 时把 canonical id 盖上（conditionally
 * spread，避免 id:undefined 覆盖默认 mint）。消灭本地 mint 与 server canonical 双权威（§9）。
 */
export function findOrCreateStreamingRow<
  T extends { id?: string; role?: string },
>(
  messages: T[],
  role: string,
  messageId: string | undefined,
  create: (idOverride: { id?: string }) => T,
): T {
  if (messageId) {
    const existing = messages.find((m) => m && m.id === messageId && m.role === role);
    if (existing) return existing;
  }
  return create(messageId ? { id: messageId } : {});
}

// 仅供类型引用（确保 block 类型在本模块内被使用，避免 unused import）。
export type _BlockRef = OutboundContentBlock;
export type _MsgRef = OutboundMessageWire;
