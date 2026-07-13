/**
 * PKCE(RFC 7636)助手 —— **通用**,非任何 provider 专属。
 *
 * 原先寄居在 providers/feishu.ts(v1 唯一 OAuth provider)。声明式 oauth2-auth-code 引擎
 * (engine/oauth2.ts)同样需要 verifier/challenge,若各自再写一份就出现"第二套 PKCE",
 * 故上移为单一权威模块。行为与原实现逐字节一致(verifier=48 随机字节 base64url = 64 字符,
 * 落在 RFC 7636 要求的 [43,128];challenge = base64url(sha256(verifier)),method 恒 S256)。
 *
 * 安全语义:verifier 是**一次性交换凭据**,只允许出现在
 *   ① 服务端 pending draft(AEAD 加密落库);
 *   ② 发往 token origin 的交换请求 body(code_verifier)。
 * challenge 是它的单向派生值,才是可以进浏览器 authorize URL 的那一半。
 */

import { createHash, randomBytes } from 'node:crypto'

/** 生成 PKCE code_verifier(64 字符 base64url ∈ RFC 7636 的 [43,128])。 */
export function generatePkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

/** verifier → code_challenge(S256)。async 签名保留(调用方沿用 await,零行为变化)。 */
export async function pkceChallengeS256(verifier: string): Promise<string> {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
