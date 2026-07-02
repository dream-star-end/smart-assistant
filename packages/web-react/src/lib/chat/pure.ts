/**
 * v5 WS 消费侧**纯函数 + 常量**——零 DOM、零 React、零 timer。
 *
 * 这些全部从现网 vanilla 权威蓝本逐条复刻（行号默认指
 * packages/web/public/modules/websocket.js，emptyTurn.js / partialJson.js /
 * state.js 已单独标注）。它们是 parity 验收的天然测试锚点：现网每个都有对应单测，
 * 漏掉/改坏任一个 = 重现一类历史已修 bug。
 */
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
/** 1008 续期：同一全局窗口最多一次（websocket.js:96）。*/
export const WS_AUTH_REFRESH_MIN_GAP_MS = 30_000;
/** ping 探活超时（websocket.js:87-88）。*/
export const PROBE_TIMEOUT_VISIBILITY_MS = 5000;
export const PROBE_TIMEOUT_KEEPALIVE_MS = 10000;
/** keepalive 心跳间隔（websocket.js:2113）。*/
export const KEEPALIVE_INTERVAL_MS = 30_000;
/** THINKING_SAFETY 兜底：10min 无新帧才杀 turn（websocket.js:274）。*/
export const THINKING_SAFETY_MS = 10 * 60_000;
/** 重连后等 replay 先赢，再 REST reconcile 的 grace（websocket.js:284）。*/
export const RECONNECT_RECONCILE_GRACE_MS = 4000;
/** reconnect 后延迟启动 drain，让 hello/resume isFinal 先到（websocket.js:2104）。*/
export const OFFLINE_DRAIN_START_DELAY_MS = 3000;
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

/** 标准指数退避 + jitter（websocket.js:2313）：2/4/8/16/30s 上限 + 0–1000ms。*/
export function backoffDelay(attempts: number): number {
  return Math.min(2000 * 2 ** attempts, 30000) + Math.random() * 1000;
}

// ═══════════════ bridge error 归一化（websocket.js:3906-3935）═══════════════

export function normalizeBridgeErrorCode(code: unknown): string {
  const raw = String(code || "").trim();
  const upper = raw.toUpperCase();
  if (upper === "ERR_INSUFFICIENT_CREDITS" || upper === "INSUFFICIENT_CREDITS") return "insufficient_credits";
  if (upper === "UNAUTHORIZED_MODEL") return "unauthorized_model";
  if (upper === "MAINTENANCE") return "maintenance";
  // 连接被踢/服务重启/背压关闭等 bridge 连接态错误 → 统一归一为 conn_kicked(友好"连接已断开")。
  if (upper === "ERR_CONN_KICKED" || upper === "CONN_KICKED") return "conn_kicked";
  if (upper === "ERR_BACKPRESSURE" || upper === "BACKPRESSURE") return "conn_kicked";
  // codex_* v5 不会到达，保留归一化无害（删 codex 专属 UI 文案即可）。
  if (upper === "CODEX_TURN_BUSY") return "codex_turn_busy";
  if (upper === "CODEX_POOL_BUSY") return "codex_pool_busy";
  if (upper === "CODEX_ROUTE_UNAVAILABLE") return "codex_route_unavailable";
  if (upper === "CODEX_CONTAINER_RECYCLED") return "codex_container_recycled";
  return raw ? raw.toLowerCase() : "unknown";
}

export function isBridgeAuthControlError(code: unknown): boolean {
  return normalizeBridgeErrorCode(code) === "unauthorized";
}

export function friendlyBridgeErrorMessage(code: unknown, message?: string): string {
  const n = normalizeBridgeErrorCode(code);
  if (n === "insufficient_credits") return "余额不足，充值后即可继续使用。";
  if (n === "unauthorized_model") return "当前账号尚未开通这个模型，请切换模型或联系管理员。";
  if (n === "maintenance") return "服务正在维护中，请稍后再试。";
  if (n === "conn_kicked") return "连接已断开（服务重启或被新会话顶替），刷新页面即可继续。";
  if (n === "codex_turn_busy") return "上一轮任务仍在运行，请等它结束后再发送。";
  if (n === "codex_pool_busy") return "账号池繁忙，请稍后重试。";
  // 未知码:回友好通用文案,不把裸技术消息(如 "server shutting down")抛给用户;
  // 原始 message 由 reducer 落进 _errorDetail,「查看详情」里仍可见,便于反馈/排查。
  return "系统暂时不可用，请稍后重试。";
}

/** 预期业务态错误码：不自动上报（websocket.js:4038）。*/
export const EXPECTED_TURN_ERR_CODES = new Set([
  "insufficient_credits",
  "unauthorized_model",
  "maintenance",
  "codex_turn_busy",
  "codex_pool_busy",
  "codex_route_unavailable",
  "codex_container_recycled",
]);

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
