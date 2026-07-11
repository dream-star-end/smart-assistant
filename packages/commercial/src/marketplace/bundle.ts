/**
 * 市场多文件工件(bundle)—— SKILL.md 之外的附属文本文件的**语义**校验与规范化
 * 单一权威(词法规则:路径白名单/限额/路径校验,住 @openclaude/protocol 供
 * 客户端预检同源引用)。
 *
 * 安全边界:
 *  - 路径白名单:references/ | assets/ | evals/ | scripts/;
 *  - scripts/ 是可执行内容:逐文件危险模式扫描(毁灭性命令 block、可疑模式出
 *    warning flag 给审核者),详情页/审核页全文透明 + 明确警示,kill-switch 兜底。
 *    执行环境本就是用户自己的隔离容器,风险面 = 恶意作者→安装用户,靠
 *    「扫描 + 人审 + 装前可见 + 可下架」四层收敛;
 *  - 词法安全:不允许 ../、绝对路径、非常规字符;深度≤2 段;
 *  - 体量上限:单文件≤64KB、总量≤256KB、≤20 个 —— 上架内容要精,不是网盘;
 *  - evals/evals.json 必须过 parseSkillEvalsJson(坏用例不允许进市场)。
 *
 * bundle 的完整性:canonicalBundleJson(排序键的稳定序列化)喂给
 * marketplaceArtifactHash,master 与容器两侧各自计算比对,不信任对方内容。
 */
import {
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_TOTAL_BYTES,
  validateBundlePath,
} from '@openclaude/protocol'
import { parseSkillEvalsJson } from '@openclaude/storage'

// 词法权威(路径白名单/限额/路径校验)住在 @openclaude/protocol/marketplaceBundle,
// 与容器侧 oc-market CLI 预检同源;这里 re-export 维持既有引用面。
export {
  BUNDLE_ALLOWED_PREFIXES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_TOTAL_BYTES,
  validateBundlePath,
} from '@openclaude/protocol'

export type BundleFiles = Record<string, string>

export type ValidateBundleResult =
  | { ok: true; bundle: BundleFiles | null }
  | { ok: false; errors: string[] }

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

// ── scripts/ 危险模式扫描 ────────────────────────────────────────────────────
// block:毁灭性/远程注入执行 —— 没有正当理由出现在市场技能脚本里。
// warn:可疑但可能正当(压缩解码执行、eval)—— 交给人审判断,不误杀。
const SCRIPT_BLOCK_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  {
    code: 'remote_pipe_exec',
    re: /\b(curl|wget)\b[^\n|;&]*\|\s*(ba|z|da)?sh\b/i,
    message: '远程内容直接管道执行(curl|sh 类)',
  },
  {
    code: 'destructive_rm',
    re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+["']?(\/|\$HOME|~)(\s|["']|$)/i,
    message: '毁灭性删除(rm -rf 根/HOME)',
  },
  { code: 'disk_destroy', re: /\b(mkfs\.|dd\s+[^\n]*of=\/dev\/)/i, message: '磁盘级破坏命令' },
  { code: 'fork_bomb', re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, message: 'fork 炸弹' },
]
const SCRIPT_WARN_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  {
    code: 'decode_exec',
    re: /base64\s+(-d|--decode)[^\n]*\|\s*(ba|z|da)?sh\b/i,
    message: '解码后执行(需人工确认用途)',
  },
  { code: 'eval_dynamic', re: /\beval\b\s*["'$(]/, message: '动态 eval(需人工确认用途)' },
  {
    code: 'creds_touch',
    re: /(\.ssh\/|\.aws\/credentials|\.npmrc|\.git-credentials)/,
    message: '触碰凭据文件路径(需人工确认用途)',
  },
]

export interface ScriptRiskFlag {
  category: 'script'
  severity: 'high' | 'medium'
  code: string
  message: string
  sample?: string
  block: boolean
}

/** 扫描单个 scripts/ 文件,返回命中的风险(block 命中 → 发布 422)。 */
export function scanScriptContent(path: string, content: string): ScriptRiskFlag[] {
  const flags: ScriptRiskFlag[] = []
  for (const p of SCRIPT_BLOCK_PATTERNS) {
    const m = content.match(p.re)
    if (m)
      flags.push({
        category: 'script',
        severity: 'high',
        code: p.code,
        message: `${path}: ${p.message}`,
        sample: m[0].slice(0, 120),
        block: true,
      })
  }
  for (const p of SCRIPT_WARN_PATTERNS) {
    const m = content.match(p.re)
    if (m)
      flags.push({
        category: 'script',
        severity: 'medium',
        code: p.code,
        message: `${path}: ${p.message}`,
        sample: m[0].slice(0, 120),
        block: false,
      })
  }
  return flags
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
