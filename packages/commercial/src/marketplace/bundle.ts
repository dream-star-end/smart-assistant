/**
 * 市场多文件工件(bundle)—— SKILL.md 之外的附属文本文件的校验与规范化单一权威。
 *
 * 安全边界:
 *  - 路径白名单:references/ | assets/ | evals/(**scripts/ 预留暂拒**:可执行内容
 *    的分发需要独立的审核/沙箱设计,先明确拒绝而不是默默吞掉);
 *  - 词法安全:不允许 ../、绝对路径、非常规字符;深度≤2 段;
 *  - 体量上限:单文件≤64KB、总量≤256KB、≤20 个 —— 上架内容要精,不是网盘;
 *  - evals/evals.json 必须过 parseSkillEvalsJson(坏用例不允许进市场)。
 *
 * bundle 的完整性:canonicalBundleJson(排序键的稳定序列化)喂给
 * marketplaceArtifactHash,master 与容器两侧各自计算比对,不信任对方内容。
 */
import { parseSkillEvalsJson } from '@openclaude/storage'

export const BUNDLE_ALLOWED_PREFIXES = ['references/', 'assets/', 'evals/'] as const
export const BUNDLE_MAX_FILES = 20
export const BUNDLE_MAX_FILE_BYTES = 64 * 1024
export const BUNDLE_MAX_TOTAL_BYTES = 256 * 1024

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type BundleFiles = Record<string, string>

export type ValidateBundleResult =
  | { ok: true; bundle: BundleFiles | null }
  | { ok: false; errors: string[] }

export function validateBundlePath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > 160) return '路径非法'
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return '路径不允许目录穿越'
  if (path.startsWith('scripts/')) return 'scripts/ 暂不支持上架(可执行内容需独立审核,后续开放)'
  if (!BUNDLE_ALLOWED_PREFIXES.some((p) => path.startsWith(p)))
    return `路径须位于 ${BUNDLE_ALLOWED_PREFIXES.join(' | ')} 之下`
  const segs = path.split('/')
  if (segs.length < 2 || segs.length > 3) return '目录深度须为 1-2 级'
  for (const seg of segs) {
    if (!SEGMENT_RE.test(seg)) return `路径段 "${seg}" 含非法字符`
  }
  return null
}

/** 校验发布入参 files:[{path,content}] → 规范化 bundle(空数组 → null)。 */
export function validateBundleFiles(
  files: Array<{ path?: unknown; content?: unknown }> | undefined,
): ValidateBundleResult {
  if (!files || files.length === 0) return { ok: true, bundle: null }
  const errors: string[] = []
  if (files.length > BUNDLE_MAX_FILES) errors.push(`附属文件最多 ${BUNDLE_MAX_FILES} 个`)
  const bundle: BundleFiles = {}
  let total = 0
  for (const f of files.slice(0, BUNDLE_MAX_FILES)) {
    const path = typeof f?.path === 'string' ? f.path.trim() : ''
    const content = typeof f?.content === 'string' ? f.content : null
    const pathErr = validateBundlePath(path)
    if (pathErr) {
      errors.push(`${path || '(空路径)'}: ${pathErr}`)
      continue
    }
    if (content === null) {
      errors.push(`${path}: content 须为字符串`)
      continue
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > BUNDLE_MAX_FILE_BYTES) {
      errors.push(`${path}: 超过单文件上限 ${BUNDLE_MAX_FILE_BYTES / 1024}KB`)
      continue
    }
    if (path in bundle) {
      errors.push(`${path}: 路径重复`)
      continue
    }
    total += bytes
    bundle[path] = content
  }
  if (total > BUNDLE_MAX_TOTAL_BYTES) errors.push(`附属文件总量超过 ${BUNDLE_MAX_TOTAL_BYTES / 1024}KB`)
  if (bundle['evals/evals.json'] !== undefined) {
    const p = parseSkillEvalsJson(bundle['evals/evals.json'])
    if (!p.ok) errors.push(`evals/evals.json: ${p.errors.join('; ')}`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, bundle: Object.keys(bundle).length > 0 ? bundle : null }
}

/** 稳定序列化(键排序)—— 两侧独立算 hash 的输入。 */
export function canonicalBundleJson(bundle: BundleFiles): string {
  const keys = Object.keys(bundle).sort()
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = bundle[k]
  return JSON.stringify(out)
}

/** 发布者自报评测摘要的校验(展示必须标注"发布者提供")。 */
export function validateBenchmark(
  raw: unknown,
): { ok: true; benchmark: { withPassRate: number; withoutPassRate: number; cases: number } | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, benchmark: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'benchmark 须为对象' }
  const o = raw as Record<string, unknown>
  const rate = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
  const w = rate(o.withPassRate)
  const wo = rate(o.withoutPassRate)
  const cases = typeof o.cases === 'number' && Number.isInteger(o.cases) && o.cases >= 1 && o.cases <= 5 ? o.cases : null
  if (w === null || wo === null || cases === null)
    return { ok: false, error: 'benchmark 字段非法(withPassRate/withoutPassRate ∈ [0,1],cases ∈ 1-5)' }
  return { ok: true, benchmark: { withPassRate: w, withoutPassRate: wo, cases } }
}
