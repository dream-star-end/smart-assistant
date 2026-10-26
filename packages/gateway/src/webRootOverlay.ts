import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

/**
 * P0-Web 前端构建目录热切换(OCV5-489)的 webRoot 决策。
 *
 * master 启动时决定 SPA 从哪里 serve:
 *   - 默认:release 自带的 packages/web-react/dist(与之前完全相同);
 *   - 配了 overlay 根(OC_V5_WEB_OVERLAY_ROOT)且 `<root>/<rel-*>/current` 是指向一份完整
 *     webroot 的符号链接 → serve 这个**符号链接路径**本身(不解析)。之后 P0-Web 原子换
 *     指针,下一个请求经 stat 回验(server.ts _staticCacheFreshOnDisk)就拿到新文件,
 *     版本探针(commercial ws/frontendBuild.ts)同样跟随,master 不重启。
 *
 * 指针按 release 目录名分桶:换 release(普通发布 / 回滚)时新进程查的是新 release 自己的
 * 桶,旧 release 上的 overlay 不可能被套到新后端上。任何一项不满足 → 回落 release dist,
 * 只是失去热切换能力,绝不影响正常 serve。
 */
export type WebRootDecision = { webRoot: string; overlay: boolean; reason: string }

const RELEASE_DIR_RE = /^rel-[A-Za-z0-9._-]+$/

export function resolveV5WebRoot(opts: {
  releaseDist: string
  releaseRoot: string
  overlayRoot: string | undefined
}): WebRootDecision {
  const { releaseDist, releaseRoot } = opts
  const overlayRoot = opts.overlayRoot?.trim()
  const fallback = (reason: string): WebRootDecision => ({ webRoot: releaseDist, overlay: false, reason })
  if (!overlayRoot) return fallback('OC_V5_WEB_OVERLAY_ROOT unset')
  let key: string
  try {
    key = basename(realpathSync(releaseRoot))
  } catch {
    return fallback(`release root unresolved: ${releaseRoot}`)
  }
  if (!RELEASE_DIR_RE.test(key)) return fallback(`not running from a rel-* release (${key})`)
  const pointer = join(overlayRoot, key, 'current')
  try {
    if (!lstatSync(pointer).isSymbolicLink()) return fallback(`${pointer} is not a symlink`)
    if (!statSync(join(pointer, 'index.html')).isFile()) return fallback(`${pointer}/index.html missing`)
  } catch {
    return fallback(`no overlay pointer at ${pointer}`)
  }
  return { webRoot: pointer, overlay: true, reason: `overlay pointer ${pointer}` }
}

/**
 * 资产池根(OC_V5_WEB_ASSETS_POOL,OCV5-632)。只接受绝对路径,其它一律视为未配置 →
 * 静态服务与之前完全一致。目录是否存在不在这里判:池缺失只是回落不命中,照常 404。
 */
export function resolveV5WebAssetsPool(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value && isAbsolute(value) ? value : undefined
}
