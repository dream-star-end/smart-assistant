/**
 * T-24 — 虎皮椒签名算法(MD5)。
 *
 * 虎皮椒开放平台的签名规范(v1.1):
 *   1. 把请求/回调所有参数(key-value)按 **key 的 ASCII 升序** 排列。
 *   2. **跳过** 两类字段:
 *      - `hash` 字段本身(它是签名结果)
 *      - 值为空字符串 / undefined / null 的字段
 *   3. 拼成 `key1=value1&key2=value2&...&keyN=valueN`(标准 query 格式,但**不做 URL 编码**)
 *   4. 末尾**直接拼接** `<APP_SECRET>`(无分隔符,不是 `&secret`!官方 PHP SDK 是 `md5($arg.$hashkey)`)
 *   5. MD5 整个字符串 → 取 **小写 16 进制**(32 字符)即为 `hash`
 *
 * 为什么 MD5 小写:虎皮椒官方示例与大部分社区实现均要求小写;如果收到的 hash 是大写,
 * 仍然统一 `.toLowerCase()` 后再 timingSafeEqual 比较,不因大小写误判。
 *
 * 安全注意(05-SECURITY §11):
 *   - APP_SECRET 绝不能记日志,抛错信息里也不能泄露 — 本模块所有 error 仅提示"签名不匹配"
 *   - 比较哈希必须用 timingSafeEqual,而非 `==` / `===`,防时序攻击
 *
 * 本文件只做纯函数签名计算,不接触网络 / 数据库;完全可以单元测试。
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** 签名算法接受的参数值类型。number 会被 `String(...)` 化;undefined/null/"" 被跳过。 */
export type SignParam = string | number | bigint | boolean | null | undefined;

/** 参数映射。key 用字符串(虎皮椒字段名都是 ASCII 小写下划线)。 */
export type SignParams = Record<string, SignParam>;

/**
 * 归一化值为字符串。null/undefined/空串 → undefined(调用方据此跳过)。
 * 0 / false / 其他基本类型 → String(v)。bigint → String(v) 不走 Number。
 */
function normalizeValue(v: SignParam): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v === "" ? undefined : v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  // 类型系统已限死,unreachable
  return undefined;
}

/**
 * 构造签名字符串(不含 APP_SECRET)。导出用于单元测试观察中间结果。
 * 调用顺序:sortedParams → join → appendSecret → md5 → hex.toLowerCase
 */
export function buildSignBase(params: SignParams): string {
  const entries: Array<[string, string]> = [];
  for (const [k, raw] of Object.entries(params)) {
    if (k === "hash") continue; // 虎皮椒规范:hash 字段不参与签名
    const v = normalizeValue(raw);
    if (v === undefined) continue;
    entries.push([k, v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * 计算签名 `hash`。
 *
 * @param params   待签名参数(必须 **不含** `hash` 字段,或传入也会被自动跳过)
 * @param appSecret 虎皮椒 AppSecret(环境变量 HUPIJIAO_APP_SECRET)
 * @returns MD5 小写 hex 字符串(32 字符)
 */
export function signHupijiao(params: SignParams, appSecret: string): string {
  if (typeof appSecret !== "string" || appSecret.length === 0) {
    throw new TypeError("signHupijiao: appSecret must be non-empty string");
  }
  const base = buildSignBase(params);
  // 官方 PHP SDK: `md5($arg.$hashkey)` —— secret 直接拼接,**不要**前置 `&`!
  // 早期文档曾误写成 `&<APP_SECRET>`,实测 40029 错误的签名,见 2026-04-19 修复。
  const input = `${base}${appSecret}`;
  return createHash("md5").update(input, "utf8").digest("hex").toLowerCase();
}

/**
 * 校验回调签名。constant-time 比较,大小写不敏感(`hash` 字段允许上游传大写)。
 *
 * @param params   回调收到的所有字段(含 `hash`)
 * @param appSecret 本地持有的 AppSecret
 * @returns true 签名匹配;false 不匹配。**永不抛异常**(调用方自行映射到 400)
 */
export function verifyHupijiao(params: SignParams, appSecret: string): boolean {
  const given = params.hash;
  if (typeof given !== "string" || given.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(given)) {
    return false;
  }
  let expected: string;
  try {
    expected = signHupijiao(params, appSecret);
  } catch {
    return false;
  }
  const a = Buffer.from(expected.toLowerCase(), "utf8");
  const b = Buffer.from(given.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
