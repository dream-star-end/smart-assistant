import { z } from "zod";

/**
 * 商业化模块的环境变量 schema。
 *
 * 本文件按 task 增量扩展:T-01 阶段只声明 DB / Redis / COMMERCIAL_ENABLED。
 * 后续 task 加入的字段(JWT_SECRET, OPENCLAUDE_KMS_KEY, HUPIJIAO_* 等)
 * 在对应 task 中补入,测试同步增加。
 *
 * 参见 docs/commercial/02-ARCHITECTURE §6.
 */

/**
 * 构造一个带协议白名单的 URL 校验器。
 *
 * 仅 `.url()` 会放过 `http://` / `ftp://` / `file://` 等协议,对基础设施 URL
 * 是安全隐患(例如有人写错成 http://... 的 DATABASE_URL,错误延迟到运行期)。
 * 这里显式收紧,05-SECURITY §7 要求的"显式边界"。
 */
function urlStringWithProtocols(allowedProtocols: ReadonlyArray<string>, field: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .url()
    .refine(
      (v) => {
        try {
          return allowedProtocols.includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      `${field} must use one of: ${allowedProtocols.map((p) => `${p}//`).join(", ")}`,
    );
}

const databaseUrl = urlStringWithProtocols(["postgres:", "postgresql:"], "DATABASE_URL");
const redisUrl = urlStringWithProtocols(["redis:", "rediss:"], "REDIS_URL");

/**
 * 仅接受 `undefined | "0" | "1"`。
 * 任何其他值(包括 "true"、"yes"、"01"、空串等)直接视为非法,抛 ConfigError。
 * 故意从严:避免误开启商业化模块、也避免部署错误被静默掩盖。
 */
const enabledFlag = z
  .enum(["0", "1"])
  .optional()
  .transform((v) => v === "1");

/**
 * Turnstile secret(Cloudflare 的 server-side key)。
 * - 生产:必填,真实 secret
 * - 测试/开发:`TURNSTILE_TEST_BYPASS=1` 时允许该字段为空,跳过远程校验
 *
 * 这里只校验"如果给了,必须非空 trim 后";具体 bypass 逻辑由 turnstile 模块判断。
 */
const turnstileSecret = z.string().trim().min(1).optional();

const turnstileBypass = z.enum(["0", "1"]).optional().transform((v) => v === "1");

/**
 * 虎皮椒支付相关(T-24)。所有字段 **optional** —— 商业化可以先不开支付功能,
 * 路由层在 deps 缺失时返 503。生产上线前必须配好,否则 /api/payment/hupi/* 全报错。
 */
const hupiAppId = z.string().trim().min(1).max(128).optional();
const hupiAppSecret = z.string().trim().min(1).max(256).optional();
const hupiCallbackUrl = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_CALLBACK_URL").optional();
const hupiReturnUrl = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_RETURN_URL").optional();
const hupiEndpoint = urlStringWithProtocols(["http:", "https:"], "HUPIJIAO_ENDPOINT").optional();

export const commercialConfigSchema = z
  .object({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    COMMERCIAL_ENABLED: enabledFlag,
    TURNSTILE_SECRET: turnstileSecret,
    TURNSTILE_TEST_BYPASS: turnstileBypass,
    HUPIJIAO_APP_ID: hupiAppId,
    HUPIJIAO_APP_SECRET: hupiAppSecret,
    HUPIJIAO_CALLBACK_URL: hupiCallbackUrl,
    HUPIJIAO_RETURN_URL: hupiReturnUrl,
    HUPIJIAO_ENDPOINT: hupiEndpoint,
  })
  .superRefine((cfg, ctx) => {
    // "给了一个就都得给":APP_ID / APP_SECRET / CALLBACK_URL 三件套要么全空要么全有。
    // 避免 "半配置" 导致运维以为开了支付但实际不通。
    const hupiTriplet: ReadonlyArray<[string, unknown]> = [
      ["HUPIJIAO_APP_ID", cfg.HUPIJIAO_APP_ID],
      ["HUPIJIAO_APP_SECRET", cfg.HUPIJIAO_APP_SECRET],
      ["HUPIJIAO_CALLBACK_URL", cfg.HUPIJIAO_CALLBACK_URL],
    ];
    const set = hupiTriplet.filter(([, v]) => v !== undefined).length;
    if (set > 0 && set < hupiTriplet.length) {
      for (const [key, v] of hupiTriplet) {
        if (v === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} required when other HUPIJIAO_* fields are set`,
          });
        }
      }
    }
  });

export type CommercialConfig = z.infer<typeof commercialConfigSchema>;

/**
 * ConfigError — env 解析失败时抛出。
 *
 * 消息只包含字段名和约束类型,不回显任何原始值,避免 secrets 泄露(05-SECURITY §16)。
 */
export class ConfigError extends Error {
  readonly issues: ReadonlyArray<{ path: string; code: string; message: string }>;

  constructor(issues: ReadonlyArray<{ path: string; code: string; message: string }>) {
    const summary = issues
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    super(`Invalid commercial config: ${summary}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * 从给定的 env 对象解析配置。
 * 默认从 process.env 读;测试可显式传入。
 *
 * 注:不做单例缓存(各调用方若需要缓存自行处理),便于测试隔离。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): CommercialConfig {
  const result = commercialConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      code: i.code,
      // i.message 由 zod 生成,不包含实际值,复用安全
      message: i.message,
    }));
    throw new ConfigError(issues);
  }
  return result.data;
}
