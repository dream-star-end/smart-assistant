/**
 * v5 自愈体系切片② 块A — 短期逐 repair 回调凭证(capability)。
 *
 * codex 回调 master(ack/progress/verify/done/failed/context)不用永久全局 token,而用
 * **逐 repair 短期 capability**:master 签发,绑定单个 repairId + attempt,90min 过期。改一个
 * repair 只能用它自己的 token,不能动别的(HMAC 载荷含 repairId+attempt → 换 repairId 校验必败)。
 *
 * 载荷设计(RFC §3 B4 / M-capability;收尾批 M2 加 jti 防重放):
 *   token = `${attempt}.${exp}.${jti}.${sig}`,其中 jti = 16B 随机 hex(32 字符),
 *   sig = hex(HMAC-SHA256(OC_SELFHEAL_MASTER_SECRET,
 *              `repair-callback.${repairId}.${attempt}.${exp}.${jti}`))
 * 自描述(attempt/exp/jti 明文随行,sig 保护它们不可篡改),verify 无需查库即可重算 sig。
 * jti 的**一次性消费**在回调端点侧(done/failed 与状态 CAS 同事务写
 * selfheal_capability_uses,冲突=重放→409;progress/ack 天然可重复不记账)。
 * 个人版把整串当**不透明** Bearer 携带(它既不解析也不签发,签发/校验都在 v5)。
 *
 * 密钥来源:env.OC_SELFHEAL_MASTER_SECRET(块C 落值;不进容器/不进 prompt/不进模型 env)。
 * 校验用 constant-time compare(timingSafeEqual),防定时侧信道爆破 sig。
 *
 * ── 跨仓契约(个人版同步实现,不许漂移)──────────────────────────────
 *   token 格式 = `${attempt}.${exp}.${jti}.${sig}`(4 段,'.' 分隔,不透明携带)。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** capability 有效期:90min(RFC 定值)。 */
export const CAPABILITY_TTL_MS = 90 * 60 * 1000;

/** sha256 hex = 64 位小写十六进制。 */
const SIG_HEX_RE = /^[0-9a-f]{64}$/;
/** jti = 16B hex = 32 位小写十六进制。 */
const JTI_HEX_RE = /^[0-9a-f]{32}$/;

export interface IssuedCapability {
  /** 不透明 Bearer 串:`${attempt}.${exp}.${jti}.${sig}`。 */
  token: string;
  /** 过期时刻(unix ms)。 */
  exp: number;
  /** 本次签发的 jti(防重放账本键;调用方一般无需使用,端点从 token 解出)。 */
  jti: string;
}

export interface CapabilityVerifyResult {
  ok: boolean;
  /** 校验通过时回带 token 内 attempt(端点用它对齐 codex_repairs.attempt)。 */
  attempt?: number;
  /** 校验通过时回带 jti(done/failed 端点同事务消费,防重放)。 */
  jti?: string;
  /** 失败原因(仅日志用,不回给调用方,避免泄露校验细节)。 */
  reason?: "malformed" | "expired" | "bad_sig" | "no_secret";
}

function masterSecret(): string {
  const s = process.env.OC_SELFHEAL_MASTER_SECRET;
  if (!s || s.length === 0) {
    throw new Error("OC_SELFHEAL_MASTER_SECRET is not configured");
  }
  return s;
}

/** 计算逐 repair 回调签名(内部)。载荷绑 repairId+attempt+exp+jti,任一变则 sig 变。 */
function signCallback(repairId: string, attempt: number, exp: number, jti: string): string {
  return createHmac("sha256", masterSecret())
    .update(`repair-callback.${repairId}.${attempt}.${exp}.${jti}`)
    .digest("hex");
}

/**
 * 签发一个逐 repair 短期 capability。exp = now + 90min;jti = 16B 随机 hex。
 * 返回不透明 token(个人版托管,附在受限 callback tool 的 Authorization Bearer)+ exp + jti。
 */
export function issueCapability(
  repairId: string,
  attempt: number,
  now: number = Date.now(),
): IssuedCapability {
  const exp = now + CAPABILITY_TTL_MS;
  const jti = randomBytes(16).toString("hex");
  const sig = signCallback(repairId, attempt, exp, jti);
  return { token: `${attempt}.${exp}.${jti}.${sig}`, exp, jti };
}

/**
 * 校验 capability:constant-time 比对 sig + 绑 repairId(sig 载荷含 repairId)+ 未过期。
 * token 结构非法/过期/sig 不符一律 ok=false;绝不因异常抛给 HTTP 层(端点据 ok 返 401)。
 */
export function verifyCapability(
  token: string,
  repairId: string,
  now: number = Date.now(),
): CapabilityVerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [attemptStr, expStr, jti, sigHex] = parts;
  if (!/^[0-9]{1,9}$/.test(attemptStr) || !/^[0-9]{1,15}$/.test(expStr)) {
    return { ok: false, reason: "malformed" };
  }
  if (!JTI_HEX_RE.test(jti)) return { ok: false, reason: "malformed" };
  if (!SIG_HEX_RE.test(sigHex)) return { ok: false, reason: "malformed" };
  const attempt = Number(attemptStr);
  const exp = Number(expStr);
  if (exp <= now) return { ok: false, reason: "expired" };

  let expectedHex: string;
  try {
    expectedHex = signCallback(repairId, attempt, exp, jti);
  } catch {
    return { ok: false, reason: "no_secret" };
  }
  // 两侧都是 32 字节 sha256,长度恒等 → timingSafeEqual 安全。
  const a = Buffer.from(sigHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_sig" };
  }
  return { ok: true, attempt, jti };
}
