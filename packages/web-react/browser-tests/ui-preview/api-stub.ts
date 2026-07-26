// UI 视觉预览台的网络边界打桩。
//
// esbuild 侧(shoot.mjs 的 ui-preview-api-stub 插件)把**整个 src 依赖图**里所有
// `…/lib/api` 的导入都改指到本文件 —— 不只是 manage/marketplace/settings 三个目录,
// 还包括它们间接拉进来的 hooks/lib(src 内共 61 处导入)。因此本文件必须是 src/lib/api
// 的**完整替身**:除 `api` 外的每个具名导出都要原样存在,少一个 bundle 直接构建失败。
//
// 面板层实际用到的非 api 具名导入(grep src/components/{manage,marketplace,settings}):
//   ApiError / apiErrorMessage / type QqBindingStatus / type QqBindingStart / type FeedbackCategory
// 但真实导出面远不止这些(authErrorMessage / bearerHeaders / callWithRefresh / refreshAuth /
// jsonOrThrow / throwApi / AuthEpochStaleError / AUTH_ERROR_MESSAGES / getExactDeferredPayload …),
// 所以这里用 `export *` 一次性透传:按 ESM 规范,本文件显式声明的 `api` 覆盖星号里的同名导出,
// 其余全部落到真实实现上(ApiError 类身份也因此与真实模块一致,instanceof 判断仍成立)。
//
// 注意:本文件自己 import 真实模块的那条边由插件放行(importer === 本文件时不重定向),
// 否则会自解析成死循环。
export * from '../../src/lib/api'

import { api as realApi } from '../../src/lib/api'
import type { ApiMockTable } from './types'

declare global {
  /** 当前场景的假实现表,由 harness 在挂载前写入。 */
  // eslint-disable-next-line no-var
  var __ocApiMocks: ApiMockTable | undefined
  /** 本次运行里被调用却没打桩的方法名(去重),shoot.mjs 汇总用。 */
  // eslint-disable-next-line no-var
  var __ocUnmockedApi: string[] | undefined
}

/**
 * 这些键不是"接口方法":返回函数会把 api 对象误判成 thenable / React 元素 / 类实例,
 * 造成 await 挂死或渲染报错。一律返回 undefined。
 */
const NON_METHOD_KEYS: ReadonlySet<string> = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'toString',
  'valueOf',
  'constructor',
  'prototype',
  'nodeType',
  'nodeName',
  '$$typeof',
  '@@iterator',
  '_isMockFunction',
  'asymmetricMatch',
  'hasAttribute',
  'tagName',
])

/** 名字看起来就该回列表的方法(未打桩时给 [] 而不是 {}),避免 .map 直接把面板打崩。 */
function looksArrayLike(name: string): boolean {
  return (
    /^(list|search|browse|fetchAll)/.test(name) ||
    /(List|Rows|Items|History|Repos|Branches|Members|Invitations|Invoices|Orders|Drafts|Runs|Reviews)$/.test(name)
  )
}

/**
 * 未打桩方法的中性返回值:绝不 throw、绝不 reject —— 一个漏打的方法不该让整块面板白屏,
 * 那样就看不到本来要评估的布局了。列表类给 [],其余给 {};两者都额外挂上常见的空容器键
 * (items/data/total…),让 `const { items } = await api.x()` 这类解构也能安全落地。
 */
function neutralResult(name: string): unknown {
  const isArray = looksArrayLike(name)
  const bag: any = isArray ? [] : {}
  const put = (key: string, value: unknown) => {
    if (isArray) {
      // 数组上必须非枚举写入,否则 JSON/展开/遍历会看到多余键;也不要覆盖 Array.prototype 上的方法。
      if (key in Array.prototype) return
      Object.defineProperty(bag, key, { value, enumerable: false, configurable: true, writable: true })
    } else {
      bag[key] = value
    }
  }
  for (const key of ['items', 'data', 'list', 'results', 'records', 'rows', 'skills', 'agents', 'connectors']) {
    put(key, [])
  }
  put('total', 0)
  put('count', 0)
  put('hasMore', false)
  put('nextCursor', null)
  put('cursor', null)
  put('ok', true)
  return bag
}

function recordUnmocked(name: string): void {
  const seen = (globalThis.__ocUnmockedApi ??= [])
  if (!seen.includes(name)) seen.push(name)
  console.warn('[unmocked-api]', name)
}

/**
 * 场景表驱动的 api 替身。命中当前场景的假实现就调它(同步抛出也转成 reject,调用方拿到的
 * 永远是 Promise);没命中就 warn + 中性值。**任何路径都不抛**。
 */
export const api = new Proxy(Object.create(null) as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined
    if (NON_METHOD_KEYS.has(prop)) return undefined
    return (...args: unknown[]): Promise<unknown> => {
      const impl = globalThis.__ocApiMocks?.[prop]
      if (typeof impl === 'function') {
        try {
          return Promise.resolve(impl(...args))
        } catch (err) {
          return Promise.reject(err)
        }
      }
      recordUnmocked(prop)
      return Promise.resolve(neutralResult(prop))
    }
  },
  has(_target, prop) {
    return typeof prop === 'string' && !NON_METHOD_KEYS.has(prop)
  },
}) as unknown as typeof realApi
