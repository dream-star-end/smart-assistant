/**
 * v5 自愈体系切片② 块A — 短期逐 repair 回调凭证(capability)。
 *
 * codex 回调 master(ack/progress/verify/done/failed/context)不用永久全局 token,而用
 * **逐 repair 短期 capability**:master 签发,绑定单个 repairId + attempt,90min 过期。改一个
 * repair 只能用它自己的 token,不能动别的(HMAC 载荷含 repairId+attempt → 换 repairId 校验必败)。
 *
 * 载荷设计(RFC §3 B4 / M-capability):token = `${attempt}.${exp}.${sig}`,其中
 *   sig = hex(HMAC-SHA256(OC_SELFHEAL_MASTER_SECRET, `repair-callback.${repairId}.${attempt}.${exp}`))
 * 是**自描述**的(attempt/exp 明文随行,sig 保护它们不可篡改),故 verify 无需查库即可
 * 重算 sig 校验。个人版把整串当**不透明** Bearer 携带(它既不解析也不签发,签发/校验都在 v5)。
 *
 * 密钥来源:env.OC_SELFHEAL_MASTER_SECRET(块C 落值;不进容器/不进 prompt/不进模型 env)。
 * 校验用 constant-time compare(timingSafeEqual),防定时侧信道爆破 sig。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** capability 有效期:90min(RFC 定值)。 */
export const CAPABILITY_TTL_MS = 90 * 60 * 1000;

/** sha256 hex = 64 位小写十六进制。 */
const SIG_HEX_RE = /^[0-9a-f]{64}$/;

export interface IssuedCapability {
  /** 不透明 Bearer 串:`${attempt}.${exp}.${sig}`。 */
  token: string;
  /** 过期时刻(unix ms)。 */
  exp: number;
}

export interface CapabilityVerifyResult {
  ok: boolean;
  /** 校验通过时回带 token 内 attempt(端点用它对齐 codex_repairs.attempt)。 */
  attempt?: number;
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

/** 计算逐 repair 回调签名(内部)。载荷绑 repairId+attempt+exp,任一变则 sig 变。 */
function signCallback(repairId: string, attempt: number, exp: number): string {
  return createHmac("sha256", masterSecret())
    .update(`repair-callback.${repairId}.${attempt}.${exp}`)
    .digest("hex");
}

/**
 * 签发一个逐 repair 短期 capability。exp = now + 90min。
 * 返回不透明 token(个人版托管,附在受限 callback tool 的 Authorization Bearer)+ exp。
 */
export function issueCapability(
  repairId: string,
  attempt: number,
  now: number = Date.now(),
): IssuedCapability {
  const exp = now + CAPABILITY_TTL_MS;
  const sig = signCallback(repairId, attempt, exp);
  return { token: `${attempt}.${exp}.${sig}`, exp };
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
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [attemptStr, expStr, sigHex] = parts;
  if (!/^[0-9]{1,9}$/.test(attemptStr) || !/^[0-9]{1,15}$/.test(expStr)) {
    return { ok: false, reason: "malformed" };
  }
  if (!SIG_HEX_RE.test(sigHex)) return { ok: false, reason: "malformed" };
  const attempt = Number(attemptStr);
  const exp = Number(expStr);
  if (exp <= now) return { ok: false, reason: "expired" };

  let expectedHex: string;
  try {
    expectedHex = signCallback(repairId, attempt, exp);
  } catch {
    return { ok: false, reason: "no_secret" };
  }
  // 两侧都是 32 字节 sha256,长度恒等 → timingSafeEqual 安全。
  const a = Buffer.from(sigHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_sig" };
  }
  return { ok: true, attempt };
}
