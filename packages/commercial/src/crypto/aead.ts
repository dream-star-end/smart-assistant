/**
 * T-04 — AES-256-GCM AEAD 封装。
 *
 * 规约(见 05-SEC §10):
 *   - 算法:AES-256-GCM(Node 原生 `crypto.createCipheriv('aes-256-gcm', ...)`)
 *   - nonce: 12 bytes,每次加密重新 randomBytes(12)
 *   - auth tag: 16 bytes,拼接在 ciphertext 后,`ciphertext = ct || tag`(业界惯例)
 *   - AAD: 可选,用于绑定上下文(例如 user_id);默认空
 *
 * 存储模型:db 同一行存 `ciphertext`(含 tag) + `nonce` 两列,见 03-DATA-MODEL §7。
 *
 * 安全规约:
 *   - 解密失败(tag 不匹配、ciphertext 被改动)→ 抛 `AeadError`
 *   - 明文字节级清零应由调用方在用完后自行处理(`zeroBuffer` 在 keys.ts)
 *   - 每次 encrypt 都 randomBytes nonce;"nonce 重用"在 GCM 下会彻底破坏机密性,
 *     因此**不提供**"确定性 nonce"接口
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class AeadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AeadError";
  }
}

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

/** 加密结果:ciphertext 已拼上 16 字节 tag;nonce 单独一份(存 DB)。 */
export interface AeadCiphertext {
  ciphertext: Buffer; // [ct || tag], length = plaintext.length + 16
  nonce: Buffer; // 12 bytes
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new AeadError(`key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

/**
 * 加密明文。
 * @param plaintext 明文字符串(UTF-8)或 Buffer
 * @param key 32 字节密钥(来自 loadKmsKey)
 * @param aad 可选的 additional authenticated data(绑定上下文)
 */
export function encrypt(
  plaintext: string | Buffer,
  key: Buffer,
  aad?: Buffer,
): AeadCiphertext {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad !== undefined) cipher.setAAD(aad);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ct, tag]),
    nonce,
  };
}

/**
 * 解密密文 + tag。
 * @returns UTF-8 字符串(MVP 用 token 都是 string;如需 Buffer 再加一条 API)
 * @throws AeadError 当 tag/aad/ciphertext 被篡改,或 nonce/key 不匹配
 */
export function decrypt(
  ciphertextWithTag: Buffer,
  nonce: Buffer,
  key: Buffer,
  aad?: Buffer,
): string {
  assertKey(key);
  if (nonce.length !== NONCE_BYTES) {
    throw new AeadError(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  if (ciphertextWithTag.length < TAG_BYTES) {
    throw new AeadError("ciphertext too short to contain auth tag");
  }
  const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_BYTES);
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(aad);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    // decipher.final() 在 tag 不对时抛 Error("Unsupported state or unable to
    // authenticate data"),统一包成 AeadError,不带原始 message 防侧信道。
    throw new AeadError("decryption failed: auth tag mismatch or ciphertext corrupted", {
      cause: err,
    });
  }
  try {
    return pt.toString("utf8");
  } finally {
    // 明文 Buffer 用完清零 —— 即便调用方持有返回的 string 副本(v8 内部)
    pt.fill(0);
  }
}
