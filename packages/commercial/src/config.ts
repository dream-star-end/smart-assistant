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

export const commercialConfigSchema = z.object({
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  COMMERCIAL_ENABLED: enabledFlag,
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
