/**
 * 商用版结构化 JSON-line 日志器:@openclaude/kernel logger 的薄包装(第三阶段 P1,OCV5-555)。
 *
 * 原先这里是一套独立实现;第三阶段方案 §3.6/§7.8 要求全仓只有一个 logger 工厂和一个脱敏实现,
 * 所以 V3 Phase 2 Task 2I-1 的行为全部改由 kernel 提供,本文件只保留商用版的 API 与策略:
 *
 * Schema(每行一个 JSON 对象,ts/level/msg 写在最后,任何字段都不能伪造它们):
 *   { "requestId": "...", "uid": 12345, ...其余 meta, "ts": "...", "level": "info", "msg": "<人话>" }
 *
 * 隐私护栏(商用版策略 = 载荷键也脱敏):
 *   - SENSITIVE_KEYS 里的键(prompt / 消息体 / raw payload / 凭据)→ "<redacted>",任意深度,
 *     bindings 与 base 同样处理;kernel 的凭据键集合是它的超集(驼峰、kebab、*_token 等后缀)
 *   - 自由文本(msg、字符串字段、Error 的 message/stack)扫描凭据格式、邮箱、手机号
 *   - 调用方仍禁止把 prompt body / Anthropic message content / system prompt 塞进 logger;
 *     这里只兜底
 *   - cyclic → "<cyclic>",深度 > 8 → "<truncated:depth>",BigInt → 字符串,
 *     Error → {name, message, stack, code?, cause?}
 *
 * 级别:默认读 LOG_LEVEL(无/非法 → info)。没有显式传 level 的 logger 共享 commercialLogLevel,
 * 运行中可改。输出:默认 stdout(measureLogWrite 计时),测试 / 重定向场景注入 out。
 */

import {
  type LevelRef,
  createLevelRef,
  createLogger as createKernelLogger,
  parseLogLevel,
  registerLevelRef,
} from "@openclaude/kernel";
import { measureLogWrite } from "@openclaude/protocol";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * 商用版必须脱敏的键(小写 snake_case)。kernel 以 payload 策略 + 凭据键覆盖它们,且是超集;
 * __tests__/logger.test.ts 锁住这份清单,commercialLoggerKernel.test.ts 锁住 kernel 确实脱敏其中每一个。
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

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /**
   * 派生子 logger;child bindings 与父 bindings 合并(child 优先),
   * 出现的每行 log 都会带上合并后的字段。Bindings 也走 redact。
   */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** 最低输出级别。低于此级别的 log 直接 drop。不传 = 共享的 commercialLogLevel。 */
  level?: LogLevel;
  /** 基础 binding,所有 log 都会带上(已 redact)。 */
  base?: Record<string, unknown>;
  /** 输出函数。默认为 process.stdout.write(line + "\n")。测试 / 重定向场景注入。 */
  out?: (line: string) => void;
  /** 时间戳生成器。默认 () => new Date().toISOString()。测试场景注入固定值。 */
  now?: () => string;
}

/** 解析 LOG_LEVEL 环境变量。无 / 非法 → "info"。 */
export function parseLevel(raw: string | undefined): LogLevel {
  return parseLogLevel(raw);
}

/** 进程级共享级别:LOG_LEVEL 启动值,运行中可改(热生效接配置在 P1 后续步骤)。 */
export const commercialLogLevel: LevelRef = createLevelRef(parseLevel(process.env.LOG_LEVEL));
registerLevelRef("commercial", commercialLogLevel);

const stdoutLine = (line: string) => {
  measureLogWrite(() => process.stdout.write(`${line}\n`), Buffer.byteLength(line) + 1);
};

/** 工厂。base 走 redact,所有 log 自动带这些字段。 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const out = opts.out ?? stdoutLine;
  return createKernelLogger({
    level: opts.level ? createLevelRef(opts.level) : commercialLogLevel,
    base: opts.base,
    redact: { payload: true, extraKeys: SENSITIVE_KEYS },
    sink: ({ line }) => out(line),
    now: opts.now,
  });
}

/**
 * 进程级单例 root logger。
 *
 * gateway/registerCommercial 把它当 root,然后用 root.child({ subsys: "commercial" })
 * 派生子系统 logger;每条请求再 child({ requestId, uid }) 拿 reqLogger。
 */
export const rootLogger: Logger = createLogger({ base: { service: "openclaude-v3" } });
