/**
 * T-04 — KMS key 加载 / 清零 / 长度校验。
 *
 * 约定(见 05-SEC §10):
 *   - `OPENCLAUDE_KMS_KEY` 环境变量:base64 编码的 32 字节密钥(AES-256)
 *   - 每条密文独立 nonce,不在本文件里管
 *   - MVP 不做轮转,但预留 key_version 概念(存储侧字段,这里只负责单 key)
 *
 * 安全规约:
 *   - loadKmsKey 返回 Buffer,调用方用完后应显式 `zeroBuffer(k)` 清零
 *   - 不做 key cache:每次 load 都重新解码,避免 Buffer 被共享后别处误清零
 *   - 长度必须严格 32 字节,否则抛错(防止配错短 key 被静默截断/0-pad)
 */

export class KmsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsKeyError";
  }
}

export const KMS_KEY_BYTES = 32;

/**
 * 从 env 读取 OPENCLAUDE_KMS_KEY(base64),返回 32 字节 Buffer。
 *
 * 失败路径:
 *   - env 未设或空 → KmsKeyError("OPENCLAUDE_KMS_KEY is not set")
 *   - base64 解码长度 ≠ 32 → KmsKeyError(附实际长度)
 *
 * 不会把 key 值回显进错误消息 —— 防止 secret 被 log 意外暴露。
 */
export function loadKmsKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.OPENCLAUDE_KMS_KEY;
  if (!raw || raw.length === 0) {
    throw new KmsKeyError("OPENCLAUDE_KMS_KEY is not set");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch (err) {
    // Buffer.from base64 实际上不会 throw,而是尽最大努力解码。保险起见保留。
    throw new KmsKeyError(
      `OPENCLAUDE_KMS_KEY is not valid base64 (${(err as Error).message})`,
    );
  }
  // Buffer.from(base64) 会丢掉非法字符而不是报错,所以必须严格校验长度。
  if (decoded.length !== KMS_KEY_BYTES) {
    throw new KmsKeyError(
      `OPENCLAUDE_KMS_KEY must decode to exactly ${KMS_KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

/** 尽最大努力把 Buffer 的字节清零(原地)。对共享 Buffer 慎用。 */
export function zeroBuffer(b: Buffer): void {
  b.fill(0);
}
