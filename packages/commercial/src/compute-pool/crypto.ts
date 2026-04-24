/**
 * Compute host 凭据 AEAD 封装。
 *
 * 与 remoteHosts/crypto.ts 同范式,但 AAD 只绑 host_id(compute_hosts 是平台级
 * 资源,不属于任何 user)。两个独立前缀防跨语义混用:
 *
 *   AAD_SSH = "compute-host-ssh:" || host_id
 *   AAD_PSK = "compute-host-psk:" || host_id
 *
 * 明文 Buffer 由调用方在用完后 .fill(0),crypto 层不兜底生命周期。
 */

import { decryptToBuffer, encrypt, type AeadCiphertext } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";

const AAD_SSH_PREFIX = "compute-host-ssh:";
const AAD_PSK_PREFIX = "compute-host-psk:";

function buildSshAad(hostId: string): Buffer {
  return Buffer.from(`${AAD_SSH_PREFIX}${hostId}`, "utf8");
}

function buildPskAad(hostId: string): Buffer {
  return Buffer.from(`${AAD_PSK_PREFIX}${hostId}`, "utf8");
}

/** 加密 SSH 密码。KMS key 用完立即清零。 */
export function encryptSshPassword(hostId: string, password: string): AeadCiphertext {
  const key = loadKmsKey();
  try {
    return encrypt(password, key, buildSshAad(hostId));
  } finally {
    zeroBuffer(key);
  }
}

/** 解密 SSH 密码 → Buffer(调用方负责 .fill(0))。 */
export function decryptSshPassword(
  hostId: string,
  nonce: Buffer,
  ciphertext: Buffer,
): Buffer {
  const key = loadKmsKey();
  try {
    return decryptToBuffer(ciphertext, nonce, key, buildSshAad(hostId));
  } finally {
    zeroBuffer(key);
  }
}

/** 加密 node-agent psk(32 bytes 随机)。输入传 Buffer,避免 hex 转换暴露。 */
export function encryptAgentPsk(hostId: string, psk: Buffer): AeadCiphertext {
  const key = loadKmsKey();
  try {
    // encrypt() 接受 string | Buffer;Buffer 情况直接走字节路径
    return encrypt(psk, key, buildPskAad(hostId));
  } finally {
    zeroBuffer(key);
  }
}

/** 解密 psk → Buffer。调用方用完 .fill(0)。 */
export function decryptAgentPsk(
  hostId: string,
  nonce: Buffer,
  ciphertext: Buffer,
): Buffer {
  const key = loadKmsKey();
  try {
    return decryptToBuffer(ciphertext, nonce, key, buildPskAad(hostId));
  } finally {
    zeroBuffer(key);
  }
}

/** 是否是 migration 写入的 self 占位(空 bytea)。空密钥不能解,直接跳过 AEAD。 */
export function isSelfPlaceholder(nonce: Buffer, ct: Buffer): boolean {
  return nonce.length === 0 && ct.length === 0;
}
