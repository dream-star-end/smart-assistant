/**
 * 稳定环境事实探针 — 注入一小块当轮实测的 uid / 实例身份 / 宿主通道 /
 * 快照 commit / 运行时目录,让 agent 不必每场用 bash 重探(实测 4 天窗口
 * 199 次探测,且 Cursor 把 HOME 换成 /tmp/openclaude-cursor.* 后会探错)。
 *
 * 约束:
 *   - 只读本地 env / 文件存在性 / MANIFEST.json 文件头,禁止网络 / ssh / docker
 *   - 进程内缓存(容器生命周期内不变),prompt 热路径不重算
 *   - 读不到就省略,不猜、不写死
 *   - 不读 HOME、不读 CLAUDE.md(自用实例的基线文件也会自称商业版容器)
 *   - Cursor 引擎会掏空 OC_USER_ID;gateway 进程 env 是权威,缺项才从
 *     /proc/1/environ 回填白名单键
 *   - 用户面时区(OCV5-166):`OC_USER_TZ` 与出口对齐的 `OPENCLAUDE_CCB_TZ`/`TZ`
 *     **正交**。引擎子进程的 `date` 报的是出口时区(风控一致性控制,刻意≠用户所在地),
 *     这里只到日期粒度给出用户时区 + 偏移,让模型不必每轮跑 `date` 再手工换算。
 *     只写时区名与偏移、不写时刻:ENV slot 落在 system prompt 缓存前缀里。
 */
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isV3ContainerRuntime } from './hostStaticProviders.js'

interface EnvPromptSlot {
  name: string
  content: string
}

export const ENV_SLOT_MAX_BYTES = 400
const MANIFEST_PATH = '/opt/openclaude/MANIFEST.json'
const MANIFEST_PREFIX_BYTES = 4096
const HOST_BIN_SUFFIX = '/.local/bin/host'
const OC_HOME_SUFFIX = '/.openclaude'
const CONTAINER_HOST_BIN = `/home/agent${HOST_BIN_SUFFIX}`
const TREE_SELFHOST = '/opt/openclaude/openclaude-v5-selfhost'
const TREE_LEGACY = '/opt/openclaude/openclaude'
const LEGACY_GIT = '/opt/openclaude/openclaude/.git'
const SELFHOST_FLAG = 'OC_SELFHOST_ENGINE_LOCAL_TURNS'
const INIT_ENVIRON_PATH = '/proc/1/environ'

/** 允许从容器 init environ 回填的键。不含 TOKEN/SECRET,也不含 HOME。 */
const INIT_ENV_KEYS = [
  'OC_USER_ID',
  'OC_CONTAINER_ID',
  'CLAUDE_CONFIG_DIR',
  'OC_SELFHOST_ENGINE_LOCAL_TURNS',
  'OPENCLAUDE_HOME',
  'OC_USER_TZ',
] as const

/** 用户面时区缺省。与 deploy 模板 `OC_USER_TZ` 及 commercial platformEnvelopeBuilder 的缺省一致。 */
export const DEFAULT_USER_TZ = 'Asia/Shanghai'

export type EnvInstance = 'v5-selfhost' | 'v5-commercial' | 'personal-legacy'

export interface EnvFacts {
  uid: string | null
  instance: EnvInstance | null
  hostBin: string | null
  hostHome: string | null
  sourceCommit: string | null
  tree: string | null
  runtimeDir: string | null
  generatedDir: string | null
  uploadsDir: string | null
  /** 用户面 IANA 时区(OC_USER_TZ 合法值,否则缺省)。永不为 null;但缺省不算「已知事实」,其他全空时整段仍省略。 */
  userTz: string
  /**
   * `UTC±HH:MM`,按探针时刻计算。**只是快照**:`renderEnvSlot` 每次重算,因为 facts 被进程级
   * 缓存而 DST 时区的偏移跨季会变 ±1h(Asia/Shanghai 无 DST,但 OC_USER_TZ 可配任意 IANA)。
   */
  userTzOffset: string | null
}

export interface EnvProbeDeps {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  isExecutable?: (path: string) => boolean
  readPrefix?: (path: string, maxBytes: number) => string | null
  /** 容器 init environ;null = 禁用回填。显式传入 env 时默认禁用。 */
  initEnvironPath?: string | null
  /** 偏移计算时刻(测试用;DST 时区偏移随季节变)。 */
  now?: Date
}

const INSTANCE_LABEL: Record<EnvInstance, string> = {
  'v5-selfhost': '新个人版V5自用',
  'v5-commercial': 'V5商业版生产',
  'personal-legacy': '老个人版',
}

const EMPTY_FACTS: EnvFacts = {
  uid: null,
  instance: null,
  hostBin: null,
  hostHome: null,
  sourceCommit: null,
  generatedDir: null,
  runtimeDir: null,
  tree: null,
  uploadsDir: null,
  userTz: DEFAULT_USER_TZ,
  userTzOffset: null,
}

let cached: EnvFacts | null = null

export function resetEnvFactsCache(): void {
  cached = null
}

function liveExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function liveIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function liveReadPrefix(path: string, maxBytes: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.toString('utf8', 0, n)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function sanitizeUid(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  return /^\d{1,12}$/.test(v) ? v : null
}

function sanitizeAgentId(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  return /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null
}

function sanitizeCommit(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  return /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null
}

/** 合法 IANA 时区 → 原样;否则 null(非法值不能进 prompt,也不能让探针抛)。 */
export function sanitizeTimeZone(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  if (!v || v.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v }).format()
    return v
  } catch {
    return null
  }
}

/** `UTC±HH:MM`。`longOffset` 给 `GMT+08:00`;UTC 给 `GMT`(无偏移段)→ `UTC+00:00`。 */
export function formatUtcOffset(tz: string, now: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(now)
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    if (name === 'GMT' || name === 'UTC') return 'UTC+00:00'
    if (name.startsWith('GMT')) return `UTC${name.slice(3)}`
    return null
  } catch {
    return null
  }
}

function sanitizeAbsPath(raw: string | undefined): string | null {
  const v = raw?.trim() ?? ''
  if (v.length < 2 || v.length > 128) return null
  if (!v.startsWith('/')) return null
  if (/[\s\0\\]/.test(v)) return null
  return v
}

function parseInitEnviron(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of buf.toString('utf8').split('\0')) {
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    if (!(INIT_ENV_KEYS as readonly string[]).includes(key)) continue
    if (out[key] !== undefined) continue
    out[key] = entry.slice(eq + 1)
  }
  return out
}

function mergeInitEnv(env: NodeJS.ProcessEnv, initPath: string | null): NodeJS.ProcessEnv {
  if (!initPath) return env
  const missing = INIT_ENV_KEYS.filter((k) => !env[k]?.trim())
  if (missing.length === 0) return env
  let filled: Record<string, string>
  try {
    filled = parseInitEnviron(readFileSync(initPath))
  } catch {
    return env
  }
  const merged: NodeJS.ProcessEnv = { ...env }
  for (const key of missing) {
    const v = filled[key]?.trim()
    if (v) merged[key] = v
  }
  return merged
}

function ocHomeDir(env: NodeJS.ProcessEnv): string | null {
  return sanitizeAbsPath(env.OPENCLAUDE_HOME)
}

function agentHomeFrom(path: string, suffix: string): string | null {
  if (!path.endsWith(suffix) || path.length <= suffix.length) return null
  return sanitizeAbsPath(path.slice(0, -suffix.length))
}

function findHostBin(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
  isExecutable: (p: string) => boolean,
): { bin: string; home: string | null } | null {
  const candidates: string[] = []
  const ocHome = ocHomeDir(env)
  if (ocHome) candidates.push(join(dirname(ocHome), '.local/bin/host'))
  candidates.push(CONTAINER_HOST_BIN)
  const seen = new Set<string>()
  for (const bin of candidates) {
    if (seen.has(bin)) continue
    seen.add(bin)
    if (!exists(bin) || !isExecutable(bin)) continue
    const home =
      agentHomeFrom(bin, HOST_BIN_SUFFIX) ?? (ocHome ? agentHomeFrom(ocHome, OC_HOME_SUFFIX) : null)
    return { bin, home }
  }
  return null
}

function readSourceCommit(readPrefix: (p: string, n: number) => string | null): string | null {
  const head = readPrefix(MANIFEST_PATH, MANIFEST_PREFIX_BYTES)
  if (!head) return null
  const m = head.match(/"sourceCommit"\s*:\s*"([0-9a-fA-F]{7,64})"/)
  return sanitizeCommit(m?.[1])
}

function classifyInstance(args: {
  uid: string | null
  inContainer: boolean
  selfhost: boolean
  host: boolean
  legacyGit: boolean
}): EnvInstance | null {
  // 自用旗标由 deploy-v5-selfhost 显式写入、生产永不设;比 uid 数字/CLAUDE.md 自述可靠。
  if (args.selfhost && (args.uid || args.inContainer)) return 'v5-selfhost'
  // 无旗标但有宿主通道:只出现在个人机自用容器,商业版生产没有这条通道。
  if (args.uid && args.host) return 'v5-selfhost'
  // 用户容器 + 无自用旗标 + 无宿主通道 → 商业版生产(uid=1 的 admin 与普通租户都是这个形态)。
  if (args.uid && args.inContainer && !args.host) return 'v5-commercial'
  // 老个人版:宿主进程无 uid,且本机有老个人版 git 树。缺席信号不能当老个人版。
  if (!args.uid && !args.inContainer && args.legacyGit) return 'personal-legacy'
  return null
}

function treeFor(instance: EnvInstance | null): string | null {
  if (instance === 'v5-selfhost') return TREE_SELFHOST
  if (instance === 'personal-legacy') return TREE_LEGACY
  return null
}

export function computeEnvFacts(deps: EnvProbeDeps = {}): EnvFacts {
  try {
    const passedEnv = deps.env !== undefined
    const initPath = deps.initEnvironPath === undefined ? (passedEnv ? null : INIT_ENVIRON_PATH) : deps.initEnvironPath
    const env = mergeInitEnv(deps.env ?? process.env, initPath)
    const exists = deps.exists ?? liveExists
    const isExecutable = deps.isExecutable ?? liveIsExecutable
    const readPrefix = deps.readPrefix ?? liveReadPrefix

    const uid = sanitizeUid(env.OC_USER_ID)
    const inContainer = isV3ContainerRuntime(env)
    const selfhost = env[SELFHOST_FLAG]?.trim() === '1'
    const host = findHostBin(env, exists, isExecutable)
    const instance = classifyInstance({
      uid,
      inContainer,
      selfhost,
      host: !!host,
      legacyGit: exists(LEGACY_GIT),
    })
    const runtimeDir = ocHomeDir(env)
    const sourceCommit = exists(MANIFEST_PATH) ? readSourceCommit(readPrefix) : null
    const userTz = sanitizeTimeZone(env.OC_USER_TZ) ?? DEFAULT_USER_TZ

    return {
      uid,
      instance,
      hostBin: host?.bin ?? null,
      hostHome: host?.home ?? (runtimeDir ? agentHomeFrom(runtimeDir, OC_HOME_SUFFIX) : null),
      sourceCommit,
      tree: treeFor(instance),
      runtimeDir,
      generatedDir: runtimeDir ? sanitizeAbsPath(join(runtimeDir, 'generated')) : null,
      uploadsDir: runtimeDir ? sanitizeAbsPath(join(runtimeDir, 'uploads')) : null,
      userTz,
      userTzOffset: formatUtcOffset(userTz, deps.now ?? new Date()),
    }
  } catch {
    return { ...EMPTY_FACTS }
  }
}

export function probeEnvFacts(deps?: EnvProbeDeps): EnvFacts {
  if (cached) return cached
  const facts = computeEnvFacts(deps)
  cached = facts
  return facts
}

function factsAreEmpty(facts: EnvFacts): boolean {
  return (
    !facts.uid &&
    !facts.instance &&
    !facts.hostBin &&
    !facts.sourceCommit &&
    !facts.tree &&
    !facts.runtimeDir
  )
}

export function renderEnvSlot(facts: EnvFacts, agentId: string, now: Date = new Date()): EnvPromptSlot | null {
  if (factsAreEmpty(facts) && !sanitizeAgentId(agentId)) return null
  if (factsAreEmpty(facts)) return null
  // 偏移现算:facts 是进程级缓存,DST 时区的偏移不能跟着 uid/路径一起被冻住。
  const userTzOffset = formatUtcOffset(facts.userTz, now) ?? facts.userTzOffset

  const lines: string[] = ['# Env · 勿重探']
  const ids: string[] = []
  if (facts.uid) ids.push(`uid=${facts.uid}`)
  const agent = sanitizeAgentId(agentId)
  if (agent) ids.push(`agent=${agent}`)
  if (ids.length) lines.push(ids.join(' '))
  if (facts.instance) lines.push(`inst=${INSTANCE_LABEL[facts.instance]}`)
  if (facts.hostBin && facts.hostHome) {
    lines.push(`host=yes HOME=${facts.hostHome} host 'cmd'`)
  } else if (facts.hostBin) {
    lines.push(`host=yes ${facts.hostBin}`)
  } else {
    lines.push('host=no')
  }
  if (facts.sourceCommit && facts.tree) {
    lines.push(`snap=${facts.sourceCommit} -> ${facts.tree}`)
  } else if (facts.sourceCommit) {
    lines.push(`snap=${facts.sourceCommit}`)
  } else if (facts.tree) {
    lines.push(`tree=${facts.tree}`)
  }
  if (facts.runtimeDir && facts.generatedDir && facts.uploadsDir) {
    lines.push(`rt=${facts.runtimeDir} gen=${facts.generatedDir} up=${facts.uploadsDir}`)
  } else if (facts.runtimeDir) {
    lines.push(`rt=${facts.runtimeDir}`)
  }
  // 用户面时区:子进程 `date`/`$TZ` 报的是出口对齐时区,不是用户所在地。
  // 只给时区名+偏移(不给时刻,免得每轮撑爆 prompt 缓存);要时刻自己 `date -u` 再换算。
  lines.push(
    userTzOffset
      ? `user_tz=${facts.userTz} ${userTzOffset} (shell date/TZ=出口时区,勿当用户时间)`
      : `user_tz=${facts.userTz} (shell date/TZ=出口时区,勿当用户时间)`,
  )

  let content = lines.join('\n')
  if (Buffer.byteLength(content, 'utf8') > ENV_SLOT_MAX_BYTES) {
    // 超预算时丢掉最长的路径行,保留身份;仍超则整段省略以免撑爆热路径。
    // user_tz 不丢:它是本 slot 里唯一纠正模型「date 即用户时间」误判的一行。
    const dropped = lines.filter((l) => !l.startsWith('rt=') && !l.startsWith('snap='))
    content = dropped.join('\n')
    if (Buffer.byteLength(content, 'utf8') > ENV_SLOT_MAX_BYTES) return null
  }
  return { name: 'ENV', content }
}

export function buildEnvSlot(ctx: { agentId: string }, deps?: EnvProbeDeps): EnvPromptSlot | null {
  try {
    const facts = deps ? computeEnvFacts(deps) : probeEnvFacts()
    return renderEnvSlot(facts, ctx.agentId)
  } catch {
    return null
  }
}
