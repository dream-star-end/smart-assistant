/**
 * T-10 — 密码哈希(argon2id)。
 *
 * 规约(见 05-SEC §1):
 *   - 算法:argon2id
 *   - memory: 64 MiB
 *   - iterations(time cost): 3
 *   - parallelism: 1
 *   - hash 长度: 默认 32 bytes
 *   - salt 由库自动 randomBytes(16)
 *
 * 输出格式:PHC 字符串 `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`,
 * 可以直接存 users.password_hash(TEXT)列,verify 时库会自己解析参数 — 未来
 * 调整参数不影响老 hash。
 *
 * 安全规约:
 *   - 密码太短/太长由上层 zod 验证,这里只做哈希
 *   - verify 永远用 timing-safe compare(argon2 库已保证)
 *   - 不在日志里出现明文密码或 hash
 */

import argon2 from "argon2";

/** 参见 05-SEC §1,这组参数是 MVP 基线,未来可加 env override。 */
export const PASSWORD_HASH_PARAMS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024, // 64 MiB(单位是 KiB)
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
};

/**
 * 哈希密码。返回 PHC 字符串(`$argon2id$...`),直接入库即可。
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string") {
    throw new TypeError("password must be a string");
  }
  return argon2.hash(password, PASSWORD_HASH_PARAMS);
}

/**
 * 校验密码是否匹配 hash。
 *
 * 返回 false 当:
 *   - 密码不匹配
 *   - hash 字符串无效/格式错误
 *   - 发生任何内部错误(避免把错误路径泄漏给调用方,防侧信道)
 *
 * 不 throw —— 登录代码可以只做 if (!ok) return Unauthorized。
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (typeof password !== "string" || typeof hash !== "string") return false;
  if (hash.length === 0) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    // hash 格式坏 / 参数不支持 等 → 统一视为失败
    return false;
  }
}
