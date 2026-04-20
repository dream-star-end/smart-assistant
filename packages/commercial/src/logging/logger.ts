/**
 * V3 Phase 2 Task 2I-1 — 结构化 JSON-line 日志器。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §15 可观测性 / 03-MVP-CHECKLIST.md Task 2I-1。
 *
 * 为什么自己写而不用 pino:
 *   - 商用版进程整体跑在 bun 之上,raw node:http 风格,不愿引一个 ~200KB
 *     的 logging 框架;90% 的功能我们自己用得上的就 30 行
 *   - 项目内已存在 LifecycleLogger 等 ad-hoc 接口(见 agent/lifecycle.ts);
 *     这里给一个统一基底,旧 ad-hoc 接口可逐步替换
 *
 * Schema(每行一个 JSON 对象):
 *   {
 *     "ts": "2026-04-20T12:34:56.789Z",
 *     "level": "info" | "warn" | "error" | "debug" | "trace",
 *     "msg": "<人话>",
 *     "requestId": "...",       // 由 child binding 注入,贯穿一次请求
 *     "uid": 12345,             // 同上
 *     "containerId": 67,        // 同上
 *     ...其余 meta 字段
 *   }
 *
 * 隐私护栏:
 *   - 任何 meta 字段 key 命中 SENSITIVE_KEYS 集合 → 值替换为 "<redacted>"
 *     (递归到嵌套对象/数组一层)
 *   - 调用方禁止把 prompt body / Anthropic message content / system prompt
 *     塞进 logger;safeguards 是 defense-in-depth
 *   - 整个 Bindings 也走同一条 redact 路径(防止 child({prompt: ...}))
 *
 * 不做的:
 *   - 不做 file rotate / sink switch:走 stdout/stderr,journald 接走
 *   - 不做 sampling:MVP 流量低,全打;若爆量先在调用方降级
 *   - 不做 async write queue:同步写,Bun stdout 已经是带缓冲的 streamable
 *   - 不做 colorized text:这是结构化 log,人眼看不下来用 jq 就行
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/**
 * Defense-in-depth:这些 key 出现在 meta / bindings 里 → 值替换为 "<redacted>"。
 *
 * 一切跟 prompt body / 用户文本 / Anthropic raw payload 沾边的字段都列在这里。
 * 调用方仍应该 **在传入前** 自行 strip,这里只兜底。
 *
 * 大小写不敏感(toLowerCase 后比较)。
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // prompt / 完整消息体
  "prompt",
  "prompt_body",
  "prompt_text",
  "messages",
  "system",
  "system_prompt",
  "user_message",
  "assistant_message",
  // raw API payload
  "raw_request",
  "raw_response",
  "request_body",
  "response_body",
  "body",
  "content",
  "text",
  "delta",
  // 凭据
  "secret",
  "secret_hash",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "anthropic_auth_token",
  "api_key",
  "cookie",
]);

const REDACTED = "<redacted>";

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /**
   * 派生子 logger;child bindings 与父 bindings 合并(child 优先),
   * 出现的每行 log 都会带上合并后的字段。
   *
   * Bindings 也走 redact;防止 `parent.child({ token: "..." })` 把凭据
   * 钉死在所有后续日志里。
   */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** 最低输出级别。低于此级别的 log 直接 drop。默认 info。 */
  level?: LogLevel;
  /** 基础 binding,所有 log 都会带上(已 redact)。 */
  base?: Record<string, unknown>;
  /**
   * 输出函数。默认为 process.stdout.write(line + "\n")。
   * 测试 / 重定向场景注入。
   */
  out?: (line: string) => void;
  /**
   * 时间戳生成器。默认 () => new Date().toISOString()。
   * 测试场景注入固定值。
   */
  now?: () => string;
}

/**
 * 递归 redact:命中 SENSITIVE_KEYS 的 value 直接替换;否则保留。
 *
 * 行为:
 *   - 数组:递归每个元素(数组 index 不算 "key",故元素本身不被 redact,
 *     但元素若是对象,内部 key 仍会被检查)
 *   - 对象:每个 own enumerable property 递归
 *   - 其他类型(string/number/bool/null/undefined/Date/Error 等):原样返回
 *
 * cyclic ref 用 WeakSet 检测,出现 → "<cyclic>"。
 * depth 限制为 8,防超深结构(配合 cyclic 检测兜底)→ "<truncated:depth>"。
 */
function redact(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (depth > 8) return "<truncated:depth>";
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  // 已经访问过同一对象 → cycle
  const seenSet = seen ?? new WeakSet<object>();
  if (seenSet.has(value as object)) return "<cyclic>";
  seenSet.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seenSet));
  }
  // Error → 拍平成 plain 对象,只保 message / name / stack
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1, seenSet);
    }
  }
  return out;
}

/**
 * 安全 JSON.stringify:遇到 cyclic ref / BigInt 等不可序列化的不抛,
 * 走 fallback("<unserializable>" / Number(big))。
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(obj, (_, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "<cyclic>";
      seen.add(value as object);
    }
    return value;
  });
}

class LoggerImpl implements Logger {
  constructor(
    private readonly level: number,
    private readonly base: Record<string, unknown>,
    private readonly out: (line: string) => void,
    private readonly now: () => string,
  ) {}

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;
    // base 在前,fields 覆盖之 —— 让单次 log 能临时改写已 bind 的字段(罕见)
    // 但 ts/level/msg 三个固定字段必须在最末覆盖,谁都不能伪造它们
    const safeFields = fields ? (redact(fields) as Record<string, unknown>) : {};
    const obj: Record<string, unknown> = {
      ...this.base,
      ...safeFields,
      ts: this.now(),
      level,
      msg,
    };
    try {
      this.out(safeStringify(obj));
    } catch (err) {
      // 兜底:绝不让 log 把进程拉崩
      // eslint-disable-next-line no-console
      console.error("[logger] emit failed:", err);
    }
  }

  trace(msg: string, fields?: Record<string, unknown>): void { this.emit("trace", msg, fields); }
  debug(msg: string, fields?: Record<string, unknown>): void { this.emit("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.emit("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.emit("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.emit("error", msg, fields); }

  child(bindings: Record<string, unknown>): Logger {
    const merged = { ...this.base, ...(redact(bindings) as Record<string, unknown>) };
    return new LoggerImpl(this.level, merged, this.out, this.now);
  }
}

/**
 * 解析 LOG_LEVEL 环境变量。无 / 非法 → "info"。
 */
export function parseLevel(raw: string | undefined): LogLevel {
  if (!raw) return "info";
  const lc = raw.toLowerCase();
  if (lc === "trace" || lc === "debug" || lc === "info" || lc === "warn" || lc === "error") {
    return lc as LogLevel;
  }
  return "info";
}

/**
 * 工厂。base 走 redact,所有 log 自动带这些字段。
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = LEVEL_ORDER[opts.level ?? parseLevel(process.env.LOG_LEVEL)];
  const base = opts.base ? (redact(opts.base) as Record<string, unknown>) : {};
  const out = opts.out ?? ((line: string) => {
    process.stdout.write(line + "\n");
  });
  const now = opts.now ?? (() => new Date().toISOString());
  return new LoggerImpl(level, base, out, now);
}

/**
 * 进程级单例 root logger。模块加载时按当前 LOG_LEVEL 实例化。
 *
 * gateway/registerCommercial 把它当 root,然后用 root.child({ subsys: "commercial" })
 * 派生子系统 logger;每条请求再 child({ requestId, uid }) 拿 reqLogger。
 */
export const rootLogger: Logger = createLogger({ base: { service: "openclaude-v3" } });
