/**
 * 远程执行机密码 AEAD 封装。
 *
 * 在通用 AES-256-GCM 之上加一层"上下文绑定":
 *   AAD = "remote-host-pw:" || userId || ":" || hostId
 *
 * 目的:防跨用户/跨记录重放。即便攻击者搞到了另一条记录的 ciphertext+nonce,
 * 也无法塞到当前 host_id 下解出(AAD 不匹配 → tag 验证失败)。
 *
 * 明文 Buffer 由调用方在用完后 .fill(0),这里不兜底。
 */

import { decryptToBuffer, encrypt, type AeadCiphertext } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";

const AAD_PREFIX = "remote-host-pw:";

function buildAad(userId: string, hostId: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${userId}:${hostId}`, "utf8");
}

/**
 * 加密密码。每次调用都会 `loadKmsKey()` 并在返回前清零,
 * 避免 KMS key 长驻。
 */
export function encryptPassword(
  userId: string,
  hostId: string,
  password: string,
): AeadCiphertext {
  const key = loadKmsKey();
  try {
    return encrypt(password, key, buildAad(userId, hostId));
  } finally {
    zeroBuffer(key);
  }
}

/**
 * 解密密码,返回 Buffer(调用方 .fill(0) 清零)。
 */
export function decryptPassword(
  userId: string,
  hostId: string,
  nonce: Buffer,
  ciphertext: Buffer,
): Buffer {
  const key = loadKmsKey();
  try {
    return decryptToBuffer(ciphertext, nonce, key, buildAad(userId, hostId));
  } finally {
    zeroBuffer(key);
  }
}
