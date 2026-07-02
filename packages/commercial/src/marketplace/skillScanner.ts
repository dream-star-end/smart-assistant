/**
 * Static policy scanner for marketplace skill artifacts.
 *
 * A skill is a prompt payload that the installing user's agent will follow, so
 * cross-tenant distribution is a long-lived injection/exfiltration surface.
 * Human review is a governance step, NOT a security boundary — this scanner is
 * the automated gate that runs at publish time (and is re-shown at review time).
 *
 * Two concerns, one pass, categorized flags:
 *   - protect the PLATFORM/other tenants from malicious skills (injection, html,
 *     internal-infra references), and
 *   - protect the PUBLISHER from leaking their own secrets/private paths when
 *     they publish (publish = public disclosure).
 *
 * Severity drives behavior in the routes:
 *   - any `block: true` flag  → publish is refused (user must fix)
 *   - otherwise flags are stored on the version + surfaced to the human reviewer.
 */

export const SKILL_SCAN_POLICY_VERSION = 1

export type RiskSeverity = 'high' | 'medium' | 'low'
export type RiskCategory =
  | 'secret'
  | 'internal'
  | 'injection'
  | 'html'
  | 'obfuscation'
  | 'metadata'
  | 'size'
  | 'script'

export interface RiskFlag {
  category: RiskCategory
  severity: RiskSeverity
  code: string
  message: string
  /** A short, redacted excerpt of what matched (never the full secret). */
  sample?: string
  /** If true, publish must be refused outright. */
  block: boolean
}

export interface SkillScanInput {
  name: string
  description: string
  tags: string[]
  body: string // SKILL.md markdown body (after frontmatter)
}

export interface SkillScanResult {
  policyVersion: number
  flags: RiskFlag[]
  blocked: boolean
}

const MAX_BODY_BYTES = 64 * 1024
const MAX_DESCRIPTION_LEN = 1024
const MAX_NAME_LEN = 64
const MAX_TAGS = 16

interface Rule {
  category: RiskCategory
  severity: RiskSeverity
  code: string
  message: string
  re: RegExp
  block: boolean
}

// ── Secret / credential patterns (block: protect the publisher + platform) ──
const SECRET_RULES: Rule[] = [
  {
    category: 'secret',
    severity: 'high',
    code: 'sk_key',
    message: '疑似 API key(sk-…)',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/,
    block: true,
  },
  {
    category: 'secret',
    severity: 'high',
    code: 'aws_key',
    message: '疑似 AWS Access Key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    block: true,
  },
  {
    category: 'secret',
    severity: 'high',
    code: 'gh_token',
    message: '疑似 GitHub token',
    re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/,
    block: true,
  },
  {
    category: 'secret',
    severity: 'high',
    code: 'private_key',
    message: 'PEM 私钥块',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
    block: true,
  },
  {
    category: 'secret',
    severity: 'high',
    code: 'jwt',
    message: '疑似 JWT/长 token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/,
    block: true,
  },
  {
    category: 'secret',
    severity: 'high',
    code: 'kv_secret',
    message: '内联密钥/密码赋值',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{12,}/i,
    block: true,
  },
]

// ── Internal infrastructure references (block: cross-tenant / platform leak) ──
const INTERNAL_RULES: Rule[] = [
  {
    category: 'internal',
    severity: 'high',
    code: 'container_token',
    message: '引用容器/平台内部 token',
    re: /OPENCLAUDE_V3_CONTAINER_TOKEN|OPENCLAUDE_V3_MASTER_BASE_URL|SKILL_EMBEDDING_API_KEY|DASHSCOPE_API_KEY|OC_BRIDGE_NONCE|DATABASE_URL|OPENCLAUDE_KMS_KEY/,
    block: true,
  },
  {
    category: 'internal',
    severity: 'high',
    code: 'internal_path',
    message: '引用平台内部路径',
    re: /\/run\/oc\/|\/var\/lib\/docker|\/etc\/openclaude|oc-v3-(?:data|codex|proj)-u\d+|\/opt\/openclaude\/openclaude\b/,
    block: true,
  },
  {
    category: 'internal',
    severity: 'high',
    code: 'internal_url',
    message: '引用内部网络地址/端点',
    re: /172\.30\.0\.1|127\.0\.0\.1:1879\d|\/internal\/v3\//,
    block: true,
  },
  {
    category: 'internal',
    severity: 'medium',
    code: 'home_dot',
    message: '引用其他用户家目录/凭证文件',
    re: /~\/\.claude\/\.credentials|\.openclaude\/(?:agents|sessions|hub)\b|~\/\.codex\/auth/,
    block: false,
  },
]

// ── Prompt-injection / exfil / tool-abuse instruction patterns (flag, not block) ──
const INJECTION_RULES: Rule[] = [
  {
    category: 'injection',
    severity: 'high',
    code: 'ignore_prev',
    message: '试图覆盖/忽略既有指令',
    re: /ignore (?:all )?(?:your |the )?(?:previous|prior|above|system) instructions|忽略(?:之前|以上|上面|系统)的?(?:所有)?指令|disregard (?:the )?system prompt/i,
    block: false,
  },
  {
    category: 'injection',
    severity: 'high',
    code: 'you_are_now',
    message: '试图重设角色/越权',
    re: /you are now (?:a |an )?|从现在起你(?:是|将)|act as (?:the )?(?:system|admin|root)/i,
    block: false,
  },
  {
    category: 'injection',
    severity: 'high',
    code: 'hide_from_user',
    message: '要求对用户隐瞒行为',
    re: /do not (?:tell|inform|mention to) the user|不要(?:告诉|通知|提示)用户|secretly|不留痕迹|without (?:the )?user(?:'s)? (?:knowledge|consent)/i,
    block: false,
  },
  {
    // High-confidence, near-zero-FP credential/secret exfiltration. A shareable
    // skill has no legitimate reason to instruct the agent to send the env /
    // secrets / credentials / memory / history out, so this BLOCKS (human review
    // is governance, not the boundary — we don't rely on a reviewer catching it).
    category: 'injection',
    severity: 'high',
    code: 'exfil_creds',
    message: '疑似外传凭证/环境/密钥/记忆',
    re: /\bsend\s+(?:the\s+)?(?:env(?:ironment)?(?:\s+variables?)?|secrets?|credentials?|api[ _-]?keys?|access[ _-]?tokens?|\.credentials|passwords?|memory|history)\s+to\b|(?:把|将)\s*(?:环境变量|密钥|凭证|令牌|token|密码|记忆|历史记录)[^\n]{0,20}(?:发送?给|上传|外发|送出|传给)/i,
    block: true,
  },
  {
    // Generic external HTTP POST/upload — too broad to block (legit skills call
    // third-party APIs), so flag + surface to reviewer and the install dialog.
    category: 'injection',
    severity: 'high',
    code: 'exfil_http',
    message: '疑似数据外传指令(外部 HTTP)',
    re: /(?:curl|wget|fetch|POST)\b[^\n]{0,80}https?:\/\/(?!claudeai\.chat)[^\s]+[^\n]{0,80}(?:--data|-d |body|upload|送出|上传|exfil)/i,
    block: false,
  },
  {
    category: 'injection',
    severity: 'medium',
    code: 'read_creds',
    message: '疑似读取凭证/环境',
    re: /cat\s+[^\n]*\.(?:credentials|env|pem)|printenv|env\s*\|\s*grep|echo\s+\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)/i,
    block: false,
  },
  {
    category: 'injection',
    severity: 'medium',
    code: 'auto_install',
    message: '诱导自动安装/发布其他 skill',
    re: /skill_save|skill_install|marketplace\/install|自动安装|auto[- ]?install/i,
    block: false,
  },
]

// ── Raw HTML / XSS in body (block: admin UI + agent context) ──
const HTML_RULES: Rule[] = [
  {
    category: 'html',
    severity: 'high',
    code: 'script_tag',
    message: '内联 <script>/<iframe>',
    re: /<\s*(?:script|iframe|object|embed)\b/i,
    block: true,
  },
  {
    category: 'html',
    severity: 'high',
    code: 'js_uri',
    message: 'javascript:/事件处理器',
    re: /javascript:\s*[^\s]|\son[a-z]+\s*=\s*["']/i,
    block: true,
  },
]

const ALL_RULES = [...SECRET_RULES, ...INTERNAL_RULES, ...INJECTION_RULES, ...HTML_RULES]

// zero-width + bidi control characters (used to hide injection text)
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤﻿]/
const HIDDEN_CHARS_G = new RegExp(HIDDEN_CHARS.source, 'g')
const stripHidden = (s: string): string => s.replace(HIDDEN_CHARS_G, '')

function redact(s: string): string {
  // keep first 6 chars, mask the rest; cap length
  const t = s.replace(/\s+/g, ' ').trim().slice(0, 48)
  return t.length > 8 ? `${t.slice(0, 6)}…(${t.length})` : t
}

function applyRules(text: string, where: string, out: RiskFlag[]): void {
  for (const r of ALL_RULES) {
    const m = r.re.exec(text)
    if (m) {
      out.push({
        category: r.category,
        severity: r.severity,
        code: `${r.code}`,
        message: `${r.message}(在${where})`,
        sample: redact(m[0]),
        block: r.block,
      })
    }
  }
}

/** Scan a skill artifact. Pure + deterministic. */
export function scanSkillArtifact(input: SkillScanInput): SkillScanResult {
  const flags: RiskFlag[] = []
  const { name, description, tags, body } = input

  // size / shape
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES)
    flags.push({
      category: 'size',
      severity: 'low',
      code: 'body_too_long',
      message: 'SKILL.md 正文过长',
      block: false,
    })
  if (name.length > MAX_NAME_LEN)
    flags.push({
      category: 'metadata',
      severity: 'low',
      code: 'name_too_long',
      message: 'name 过长',
      block: false,
    })
  if (tags.length > MAX_TAGS)
    flags.push({
      category: 'metadata',
      severity: 'low',
      code: 'too_many_tags',
      message: 'tags 过多',
      block: false,
    })

  // description/tags are tier-1 metadata that enter agent context — must be
  // plain single-line text (no markdown/html/newlines = injection surface)
  if (description.length > MAX_DESCRIPTION_LEN)
    flags.push({
      category: 'metadata',
      severity: 'low',
      code: 'desc_too_long',
      message: 'description 过长',
      block: false,
    })
  if (/[\r\n]/.test(name) || /<[a-z!/]/i.test(name))
    flags.push({
      category: 'metadata',
      severity: 'high',
      code: 'name_not_plain',
      message: 'name 必须是纯文本(禁换行/HTML)',
      block: true,
    })
  if (/[\r\n]/.test(description) || /<[a-z!/]/i.test(description))
    flags.push({
      category: 'metadata',
      severity: 'high',
      code: 'desc_not_plain',
      message: 'description 必须是纯文本(禁换行/HTML)',
      block: true,
    })
  for (const t of tags)
    if (/[\r\n<>]/.test(t))
      flags.push({
        category: 'metadata',
        severity: 'high',
        code: 'tag_not_plain',
        message: 'tag 含非法字符',
        block: true,
      })

  // hidden / obfuscation chars. In tier-1 metadata they have no legitimate use
  // and can hide injection text → block. In the body they're suspicious but
  // markdown can carry odd chars legitimately → flag (and we de-obfuscate before
  // pattern matching below so they can't split a block pattern apart).
  const metaHay = `${name}\n${description}\n${tags.join(' ')}`
  if (HIDDEN_CHARS.test(metaHay))
    flags.push({
      category: 'obfuscation',
      severity: 'high',
      code: 'hidden_chars_meta',
      message: '元数据含零宽/双向控制字符',
      block: true,
    })
  if (HIDDEN_CHARS.test(body))
    flags.push({
      category: 'obfuscation',
      severity: 'medium',
      code: 'hidden_chars',
      message: '含零宽/双向控制字符(可能藏匿注入文本)',
      block: false,
    })

  // pattern rules across metadata + body — scanned both as-is AND with hidden
  // chars stripped, so e.g. `OPENCLAUDE_V3_<zwsp>CONTAINER_TOKEN` can't slip a
  // block pattern past the regex by splitting it with zero-width characters.
  const meta = `${name} ${description} ${tags.join(' ')}`
  applyRules(meta, '元数据', flags)
  applyRules(body, '正文', flags)
  const strippedMeta = stripHidden(meta)
  const strippedBody = stripHidden(body)
  if (strippedMeta !== meta) applyRules(strippedMeta, '元数据', flags)
  if (strippedBody !== body) applyRules(strippedBody, '正文', flags)

  // Combination escalation: reading credentials/env AND posting to an external
  // host together in one artifact form a suspected exfil chain. We surface this
  // as a prominent high-severity FLAG (shown to the reviewer + in the install-
  // confirm dialog) rather than a hard publish block — the mechanical "read an
  // env secret then call a third-party API" pattern has legitimate uses (a skill
  // authenticating to its own API), so a hard block would refuse valid skills.
  // Reviewer + install-time disclosure carry this one. (The explicit
  // "send credentials/secrets to …" phrasing is still a hard block via
  // exfil_creds — that one has near-zero false positives.)
  const hasReadCreds = flags.some((f) => f.code === 'read_creds')
  const hasExfilHttp = flags.some((f) => f.code === 'exfil_http')
  if (hasReadCreds && hasExfilHttp)
    flags.push({
      category: 'injection',
      severity: 'high',
      code: 'cred_exfil_chain',
      message: '同一 skill 同时读取凭证/环境并向外部 POST(疑似外泄链,请重点核对)',
      block: false,
    })

  // dedupe by code+category (a pattern may hit metadata and body)
  const seen = new Set<string>()
  const deduped = flags.filter((f) => {
    const k = `${f.category}:${f.code}:${f.severity}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return {
    policyVersion: SKILL_SCAN_POLICY_VERSION,
    flags: deduped,
    blocked: deduped.some((f) => f.block),
  }
}
