/**
 * T-33 — Claude Messages API 代理(SSE 流式透传)。
 *
 * 规约(见 01-SPEC F-6.7,02-ARCH §2.7):
 *   - `streamClaude({account, body}) → AsyncIterable<ProxyEvent>`
 *   - 用 `fetch` + ReadableStream 直接读原始 SSE,解析成事件后 yield
 *   - 非 2xx 立即抛(401 → ProxyAuthError;其他 → ProxyError),调用方决定是否 refresh + 重试
 *   - 不做 refresh / retry / 熔断 —— 那些在上层 orchestrator(T-40 ws/chat.ts)里组合
 *
 * SSE 解析:
 *   - 事件由**空行**分隔(`\n\n` 或 `\r\n\r\n`)
 *   - 每条事件里:`event: <name>`、`data: <string>`、以 `:` 开头的是注释(SSE keep-alive)
 *   - 多行 data 合并为 `lines.join('\n')`;Claude 实际只用单行,但解析器走正式 SSE 规约
 *   - 见到 `data: [DONE]` → 正常结束(Anthropic v1/messages 也会发 `message_stop` 事件,
 *     两者任一出现都 OK;我们在遇到 `[DONE]` 时 return)
 *
 * 安全规约:
 *   - Authorization header 用 `Bearer ${token.toString('utf8')}`;调用方传进来的 Buffer
 *     生命周期由调用方管,streamClaude **不**清零 token(因为可能还要重试)
 *   - 错误对象只带 status + 前 500 char body,不暴露 token / header
 */

import type { AccountPlan } from "./store.js";

export const DEFAULT_CLAUDE_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
/**
 * 单次 SSE 解析 buffer 字符上限。超过 → cancel reader + 抛 ProxyError。
 *
 * 设这个上限是为了防恶意/异常上游一直不发空行、或单事件大得离谱
 * 把 gateway 的内存慢慢啃光。1MB 字符对正常 Claude 事件(一般几 KB)
 * 绰绰有余,足以容纳最长 message_delta。
 */
export const DEFAULT_MAX_SSE_BUFFER = 1024 * 1024;

/** 响应错误:非 2xx HTTP 状态触发。 */
export class ProxyError extends Error {
  readonly status: number;
  readonly bodyPreview: string;
  constructor(status: number, bodyPreview: string, message?: string) {
    super(
      message ??
        `Claude API returned ${status}: ${bodyPreview.slice(0, 200)}`,
    );
    this.name = "ProxyError";
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

/**
 * 401 专用子类 —— 上层据此决定是否 refresh + 重试。
 * 403(账号被禁)不归类 auth —— 真刷新也救不回来,直接挂。
 */
export class ProxyAuthError extends ProxyError {
  constructor(bodyPreview: string) {
    super(401, bodyPreview, `Claude API 401 (token expired/invalid)`);
    this.name = "ProxyAuthError";
  }
}

/**
 * 一条已解析的 SSE 事件。`raw` 保留原 data 字符串,便于透传到前端(不改编码)。
 */
export interface ProxyEvent {
  /** SSE `event:` 字段;默认 "message" */
  event: string;
  /** `data:` 字段 JSON.parse 后的结构;失败则 === raw */
  data: unknown;
  /** 原始 data 文本(通常就是 JSON 字符串) */
  raw: string;
}

export interface StreamClaudeInput {
  account: {
    /** 解密后的明文 bearer token。生命周期由调用方管。 */
    token: Buffer;
    plan?: AccountPlan;
  };
  /** 已组好的 Messages 请求体(不含 stream,内部强制 true) */
  body: Record<string, unknown>;
  /** 可传入 AbortSignal 用于取消 */
  signal?: AbortSignal;
}

export interface ProxyDeps {
  /** 注入 fetch(测试可 mock);默认 globalThis.fetch */
  fetch?: typeof fetch;
  /** Messages 端点;默认 api.anthropic.com/v1/messages */
  endpoint?: string;
  /** anthropic-version header;默认 2023-06-01 */
  anthropicVersion?: string;
  /** anthropic-beta header(可不给) */
  anthropicBeta?: string;
  /** SSE 解析 buffer 字符上限;默认 1MB。超限 → cancel + ProxyError */
  maxBufferBytes?: number;
}

/**
 * 组 Authorization header。单独抽出便于测试 + 未来换 OAuth vs API Key。
 */
function buildAuthHeader(token: Buffer): string {
  return `Bearer ${token.toString("utf8")}`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

/** SSE 事件边界查找:返回第一个 \n\n 或 \r\n\r\n 的位置(不含空行)。 */
function findEventBoundary(buf: string): { idx: number; sepLen: number } | null {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1 && b === -1) return null;
  if (a === -1) return { idx: b, sepLen: 4 };
  if (b === -1) return { idx: a, sepLen: 2 };
  return a < b ? { idx: a, sepLen: 2 } : { idx: b, sepLen: 4 };
}

/** 把一段 raw(不含尾部空行)解析成 { event, data }。只有 data 行的才算有效事件。 */
function parseSseEvent(raw: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE 注释(keep-alive)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE 规约:值前若有一个空格应剥掉
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function toProxyEvent(ev: { event: string; data: string }): ProxyEvent {
  let data: unknown;
  try {
    data = JSON.parse(ev.data);
  } catch {
    data = ev.data;
  }
  return { event: ev.event, data, raw: ev.data };
}

/**
 * 流式发请求 + 透传 SSE 事件。
 *
 * @throws {@link ProxyAuthError} 上游返 401
 * @throws {@link ProxyError} 上游返其他非 2xx
 */
export async function* streamClaude(
  input: StreamClaudeInput,
  deps: ProxyDeps = {},
): AsyncGenerator<ProxyEvent, void, void> {
  const fetchFn = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? DEFAULT_CLAUDE_ENDPOINT;
  const version = deps.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "anthropic-version": version,
    authorization: buildAuthHeader(input.account.token),
  };
  if (deps.anthropicBeta) headers["anthropic-beta"] = deps.anthropicBeta;

  const reqBody = JSON.stringify({ ...input.body, stream: true });
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: reqBody,
    signal: input.signal,
  });

  if (res.status === 401) {
    throw new ProxyAuthError(await safeReadText(res));
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ProxyError(res.status, await safeReadText(res));
  }
  if (!res.body) {
    throw new ProxyError(
      res.status,
      "",
      `Claude API ${res.status} but no response body to stream`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const maxBuf = deps.maxBufferBytes ?? DEFAULT_MAX_SSE_BUFFER;
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 循环提取完整事件(buffer cap 在提取之后再检查:如果一整块 chunk
      // 里含完整事件,即便超 cap 也能先 yield 出去再判)
      while (true) {
        const b = findEventBoundary(buf);
        if (!b) break;
        const raw = buf.slice(0, b.idx);
        buf = buf.slice(b.idx + b.sepLen);
        const ev = parseSseEvent(raw);
        if (!ev) continue;
        if (ev.data === "[DONE]") return;
        yield toProxyEvent(ev);
      }
      // 剩余 buffer 超上限 → 取消 + 抛。避免对端一直不发空行把内存啃空。
      if (buf.length > maxBuf) {
        try {
          await reader.cancel();
        } catch {
          /* reader 可能已释放 */
        }
        throw new ProxyError(
          0,
          buf.slice(0, 200),
          `SSE buffer exceeded ${maxBuf} chars without event boundary`,
        );
      }
    }
    // flush trailing buffer —— 大多数实现都以空行收尾,但保险起见处理遗留片段
    // 用 `/\S/` 判空而非 buf.trim(),避免破坏原始 data 文本
    if (/\S/.test(buf)) {
      const ev = parseSseEvent(buf);
      if (ev !== null && ev.data !== "[DONE]") {
        yield toProxyEvent(ev);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* stream 已关闭时 releaseLock 可能抛 */
    }
  }
}
