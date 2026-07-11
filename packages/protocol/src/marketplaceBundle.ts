/**
 * 市场技能 bundle(SKILL.md 之外的附属文件)的词法权威 —— 路径白名单、限额、
 * 路径校验规则的唯一定义处。
 *
 * 分层:这里只放**纯词法**规则(字符串运算,浏览器/容器 CLI/master 三侧可共用);
 * 语义校验(evals.json 解析、scripts 危险模式扫描、总量按 UTF-8 字节计)留在
 * master 侧 commercial/marketplace/bundle.ts —— 那些依赖 @openclaude/storage 与
 * Node Buffer,且服务端才是最终裁决权威。客户端(oc-market CLI / Web 表单)引用
 * 本模块做预检,靠常量同源保证"预检通过 ≈ 服务端通过"。
 */

export const BUNDLE_ALLOWED_PREFIXES = ['references/', 'assets/', 'evals/', 'scripts/'] as const
export const BUNDLE_MAX_FILES = 20
export const BUNDLE_MAX_FILE_BYTES = 64 * 1024
export const BUNDLE_MAX_TOTAL_BYTES = 256 * 1024

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 校验单个 bundle 相对路径;合法返回 null,否则返回人话错误原因。 */
export function validateBundlePath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 160) return '路径非法'
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return '路径不允许目录穿越'
  if (!BUNDLE_ALLOWED_PREFIXES.some((p) => path.startsWith(p)))
    return `路径须位于 ${BUNDLE_ALLOWED_PREFIXES.join(' | ')} 之下`
  const segs = path.split('/')
  if (segs.length < 2 || segs.length > 3) return '目录深度须为 1-2 级'
  for (const seg of segs) {
    if (!SEGMENT_RE.test(seg)) return `路径段 "${seg}" 含非法字符`
  }
  return null
}
