/**
 * /api/admin/* 跨资源共享的 HTTP 解析/错误翻译 helper。
 *
 * S3 拆分自 http/admin.ts。函数体逐字节等价(plan §3.1 + §4.5)。
 *
 * 收录红线(plan §3.4):
 * - 只放纯 HTTP 解析/通用错误翻译,不放 domain 类型(User/Account/Order/...)
 * - caller ≥ 2 跨资源才进来,单资源 helper 跟随主资源出去
 *
 * 当前居民:
 * - parsePositiveInt    — 通用 limit 校验,几乎所有 list 接口都用
 * - parseNonNegativeInt — offset 校验,used by users.csv/orders/inbox/egress-proxies/...
 * - translateRangeError — RangeError → 400 VALIDATION 翻译,几乎所有 ops 层都抛
 * - parseBigintIdParam  — PG BIGINT 范围 + 数字格式校验,used by ledger/orders/feedback
 * - parseUserId         — parseBigintIdParam 的 user_id 别名,used by ledger/orders/feedback
 * - parseIsoTimestamp   — ISO timestamp 字符串校验,used by ledger/orders/feedback
 * - extractTailId       — `/api/admin/<resource>/:id` 抽 :id,used by users/accounts/inbox/egress-proxies
 * - extractTailSlug     — `/api/admin/<resource>/<slug>` 通用版,正则可配,used by pricing/plans
 */

import { HttpError } from "../util.js";

/** 同一通用 limit 校验 */
export function parsePositiveInt(raw: string | null, name: string, max: number): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new HttpError(400, "VALIDATION", `${name} must be 1..${max}`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return n;
}

export function parseNonNegativeInt(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "VALIDATION", `${name} must be >= 0`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return n;
}

/** 解析 `/api/admin/users/:id` → `id` */
export function extractTailId(url: URL, prefix: string): string {
  const tail = url.pathname.slice(prefix.length);
  if (!/^[1-9][0-9]{0,19}$/.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid id in URL", {
      issues: [{ path: "id", message: tail }],
    });
  }
  return tail;
}

/** 从 `/api/admin/{pricing,plans}/<slug>` 抽 slug,用配套的正则验。 */
export function extractTailSlug(url: URL, prefix: string, re: RegExp): string {
  const tail = url.pathname.slice(prefix.length);
  if (!re.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid slug in URL", {
      issues: [{ path: "slug", message: tail }],
    });
  }
  return tail;
}

/** RangeError(来自 ops 层)统一翻译成 400 VALIDATION。 */
export function translateRangeError(err: unknown): never {
  if (!(err instanceof RangeError)) throw err;
  const path = err.message.replace(/^invalid_/, "");
  throw new HttpError(400, "VALIDATION", `invalid ${path}`, {
    issues: [{ path, message: err.message }],
  });
}

// PG BIGINT 上限 = 9223372036854775807 (19 digits)。正则放到 20 位,溢出靠 BigInt 比较拦截。
const BIGINT_MAX = 9223372036854775807n;
export function parseBigintIdParam(raw: string | null, name: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,19}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION", `invalid ${name}`, {
      issues: [{ path: name, message: raw }],
    });
  }
  if (BigInt(raw) > BIGINT_MAX) {
    throw new HttpError(400, "VALIDATION", `${name} out of range`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return raw;
}

export function parseUserId(raw: string | null): string | undefined {
  return parseBigintIdParam(raw, "user_id");
}

export function parseIsoTimestamp(raw: string | null, name: string): string | undefined {
  if (raw === null || raw === "") return undefined;
  // 简单校验:Date 解析得出来即可。多余格式由 PG ::timestamptz 兜底。
  if (Number.isNaN(Date.parse(raw))) {
    throw new HttpError(400, "VALIDATION", `${name} must be ISO timestamp`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return raw;
}
