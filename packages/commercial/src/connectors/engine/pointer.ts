/**
 * 连接器平台 · JSON Pointer(RFC6901)解析(identity probe 结果 / token 交换响应共用)。
 * 只读解析进普通 JSON;缺失/越界返回 undefined;拒污染段(__proto__/prototype/constructor)。
 * 独立模块以打破 bind ↔ tokenExchange 的循环依赖。
 */

const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

export function resolveResultPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined
  const segs = pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur = root
  for (const seg of segs) {
    if (POLLUTION_KEYS.has(seg)) return undefined
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      const idx = Number(seg)
      if (idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}
