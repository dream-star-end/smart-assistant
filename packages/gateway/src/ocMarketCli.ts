/**
 * oc-market — in-container CLI the AI uses to operate the AI marketplace on the
 * user's behalf. Talks to master's /internal/v3/marketplace/agent/* with the
 * container token (same transport as the hub sync). Every op is scoped to this
 * container's user by the server; install is limited to admin-approved content;
 * publish goes to the review queue (never live without admin approval).
 *
 * Usage (the `market` baseline skill documents this for the agent):
 *   oc-market search <query> [--kind skill|agent|plugin]
 *   oc-market detail <slug>
 *   oc-market installed
 *   oc-market install <slug>
 *   oc-market uninstall <slug>
 *   oc-market publish-skill --slug <s> --name <n> --version <v> --description <d> --body-file <f>
 *     --category <id> --use-cases "a;b" [--outcomes "a;b"] [--intro-file <f>] [--tags a,b]
 *     [--bundle-dir <dir>] [--benchmark-file <f>] [--visibility org]
 *   oc-market publish-agent --slug <s> --name <n> --version <v> --description <d> --model <m>
 *     --toolsets a,b --persona-file <f> --category <id> --use-cases "a;b"
 *     [--outcomes "a;b"] [--intro-file <f>] [--skill-deps a,b] [--plugin-deps a,b]
 *     [--optional-skill-deps a,b] [--optional-plugin-deps a,b] [--tags a,b] [--visibility org]
 *
 * Storefront ("人向商品层") metadata carried on publish (validated server-side):
 *   --category <id>       one of the marketplace taxonomy ids (required)
 *   --use-cases "a;b"     1-4 "what the user wants to do" sentences, ';'-separated (required)
 *   --outcomes "a;b"      0-4 concrete "give X → get Y" effect examples, ';'-separated (optional)
 *   --intro-file <f>      Markdown rich intro rendered on the storefront page (optional) → humanMd
 *
 * Multi-file skill payload (publish-skill only; server is the final authority):
 *   --bundle-dir <dir>    collect ALL files under <dir>/{references,assets,evals,scripts}/
 *                         as the skill's bundle (≤20 files / ≤64KB each / ≤256KB total,
 *                         limits shared with the server via @openclaude/protocol).
 *                         SKILL.md body still goes through --body-file.
 *   --benchmark-file <f>  publisher-reported eval summary JSON:
 *                         {"withPassRate":0..1,"withoutPassRate":0..1,"cases":1-5}
 *   --visibility org      publish org-private (requires the user to be an active
 *                         org member; default public)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  BUNDLE_ALLOWED_PREFIXES,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  validateBundlePath,
} from '@openclaude/protocol'

function fail(msg: string): never {
  process.stderr.write(`oc-market: ${msg}\n`)
  process.exit(1)
}

type FileReader = (path: string, encoding: BufferEncoding) => string

function readContainerTokenIfAvailable(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): string | null {
  const tok = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (tok) return tok
  const file = env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
  if (!file) return null
  try {
    const fromFile = readFile(file, 'utf8').trim()
    return fromFile || null
  } catch {
    return null
  }
}

export interface MarketplaceEndpoint {
  baseUrl: string
  token?: string
  mode: 'master' | 'local'
}

export function resolveLocalGatewayBase(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): string | null {
  const home = env.OPENCLAUDE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.openclaude')
  try {
    const cfg = JSON.parse(readFile(join(home, 'openclaude.json'), 'utf8')) as {
      gateway?: { port?: unknown }
    }
    const port =
      typeof cfg.gateway?.port === 'number' ? cfg.gateway.port : Number(cfg.gateway?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return `http://127.0.0.1:${port}/internal/v3/marketplace/agent-local`
  } catch {
    return null
  }
}

export function resolveMarketplaceEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): MarketplaceEndpoint {
  const masterBase = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = readContainerTokenIfAvailable(env, readFile)
  if (masterBase && token) {
    return {
      baseUrl: `${masterBase.replace(/\/+$/, '')}/internal/v3/marketplace/agent`,
      token,
      mode: 'master',
    }
  }
  const localBase = resolveLocalGatewayBase(env, readFile)
  if (localBase) return { baseUrl: localBase, mode: 'local' }
  if (masterBase)
    throw new Error(
      'not in a commercial container (no container token and no local gateway config)',
    )
  throw new Error('not in a commercial container (no master base url or local gateway config)')
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : 'true'
      flags[key] = val
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

/** Split a delimited flag value into a trimmed, empty-filtered string[]. */
export function splitList(raw: string | undefined, sep: ',' | ';'): string[] {
  return raw
    ? raw
        .split(sep)
        .map((t) => t.trim())
        .filter(Boolean)
    : []
}

export interface BundleFileEntry {
  path: string
  content: string
}

/**
 * 收集 --bundle-dir 下的附属文件:只认 references/ assets/ evals/ scripts/ 四个
 * 白名单子目录(SKILL.md 正文另走 --body-file)。路径规则与限额同源自
 * @openclaude/protocol,和服务端一致 —— 预检把所有问题一次说清,而不是打一发
 * 422 再猜。返回按路径排序,保证同一目录两次发布产物一致。
 */
export function collectBundleDir(
  dir: string,
  readDir: (p: string) => Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = (
    p,
  ) => readdirSync(p, { withFileTypes: true }),
  readFile: FileReader = readFileSync,
): { files: BundleFileEntry[]; errors: string[] } {
  const relPaths: string[] = []
  const errors: string[] = []
  const walk = (abs: string, rel: string, isRoot: boolean): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readDir(abs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      // 白名单根目录不存在 = 没有该类附属文件,正常;其余失败(权限/IO/嵌套目录
      // 读不了)必须显式报出 —— 静默跳过等于发布残缺 bundle。
      if (!(isRoot && (code === 'ENOENT' || code === 'ENOTDIR')))
        errors.push(`${rel}: 目录读取失败(${code ?? 'unknown'})`)
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(abs, e.name), `${rel}${e.name}/`, false)
      else if (e.isFile()) relPaths.push(`${rel}${e.name}`) // symlink 等特殊类型一律忽略
    }
  }
  for (const prefix of BUNDLE_ALLOWED_PREFIXES)
    walk(join(dir, prefix.replace(/\/$/, '')), prefix, true)
  relPaths.sort()
  const files: BundleFileEntry[] = []
  let total = 0
  if (relPaths.length === 0)
    errors.push(`目录下没有可发布的附属文件(只认 ${BUNDLE_ALLOWED_PREFIXES.join(' ')} 子目录)`)
  if (relPaths.length > BUNDLE_MAX_FILES)
    errors.push(`附属文件最多 ${BUNDLE_MAX_FILES} 个(实际 ${relPaths.length} 个)`)
  for (const rel of relPaths) {
    const pathErr = validateBundlePath(rel)
    if (pathErr) {
      errors.push(`${rel}: ${pathErr}`)
      continue
    }
    let content: string
    try {
      content = readFile(join(dir, rel), 'utf8')
    } catch {
      errors.push(`${rel}: 读取失败`)
      continue
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > BUNDLE_MAX_FILE_BYTES) {
      errors.push(`${rel}: 超过单文件上限 ${BUNDLE_MAX_FILE_BYTES / 1024}KB`)
      continue
    }
    total += bytes
    files.push({ path: rel, content })
  }
  if (total > BUNDLE_MAX_TOTAL_BYTES)
    errors.push(`附属文件总量超过 ${BUNDLE_MAX_TOTAL_BYTES / 1024}KB`)
  return { files, errors }
}

export interface PublishSkillRequest {
  kind: 'skill'
  slug?: string
  name?: string
  version?: string
  description?: string
  category?: string
  tags: string[]
  useCases: string[]
  outcomeExamples: string[]
  humanMd?: string
  body: string
  files?: BundleFileEntry[]
  benchmark?: unknown
  visibility?: 'org'
}

export interface PublishAgentRequest {
  kind: 'agent'
  slug?: string
  name?: string
  version?: string
  description?: string
  category?: string
  model?: string
  toolsets: string[]
  capabilities: Array<{ kind: 'skill' | 'plugin'; slug: string; optional: boolean }>
  /** Compatibility projection consumed by older V5 runtimes. */
  skillDeps: string[]
  tags: string[]
  useCases: string[]
  outcomeExamples: string[]
  humanMd?: string
  persona: string
  visibility?: 'org'
}

/**
 * Assemble the publish-skill request body from parsed flags + already-read files.
 * Pure (no IO): storefront metadata (category/useCases/outcomeExamples/humanMd) is
 * validated by the server, not here. `--use-cases`/`--outcomes` are ';'-separated
 * because each entry is a full sentence that may itself contain commas.
 */
export function buildPublishSkillRequest(
  flags: Record<string, string>,
  body: string,
  humanMd?: string,
  extras?: { files?: BundleFileEntry[]; benchmark?: unknown; visibility?: 'org' },
): PublishSkillRequest {
  return {
    kind: 'skill',
    slug: flags.slug,
    name: flags.name,
    version: flags.version,
    description: flags.description,
    category: flags.category,
    tags: splitList(flags.tags, ','),
    useCases: splitList(flags['use-cases'], ';'),
    outcomeExamples: splitList(flags.outcomes, ';'),
    ...(humanMd != null ? { humanMd } : {}),
    body,
    ...(extras?.files && extras.files.length > 0 ? { files: extras.files } : {}),
    ...(extras?.benchmark !== undefined ? { benchmark: extras.benchmark } : {}),
    ...(extras?.visibility ? { visibility: extras.visibility } : {}),
  }
}

/** Assemble the publish-agent request body (same storefront metadata as skills). */
export function buildPublishAgentRequest(
  flags: Record<string, string>,
  persona: string,
  humanMd?: string,
  extras?: { visibility?: 'org' },
): PublishAgentRequest {
  const uniqueList = (value: string | undefined) => [...new Set(splitList(value, ','))]
  const requiredSkills = uniqueList(flags['skill-deps'])
  const requiredPlugins = uniqueList(flags['plugin-deps'])
  const optionalSkills = uniqueList(flags['optional-skill-deps']).filter(
    (slug) => !requiredSkills.includes(slug),
  )
  const optionalPlugins = uniqueList(flags['optional-plugin-deps']).filter(
    (slug) => !requiredPlugins.includes(slug),
  )
  const capabilities = [
    ...requiredSkills.map((slug) => ({ kind: 'skill' as const, slug, optional: false })),
    ...requiredPlugins.map((slug) => ({ kind: 'plugin' as const, slug, optional: false })),
    ...optionalSkills.map((slug) => ({ kind: 'skill' as const, slug, optional: true })),
    ...optionalPlugins.map((slug) => ({ kind: 'plugin' as const, slug, optional: true })),
  ]
  return {
    kind: 'agent',
    slug: flags.slug,
    name: flags.name,
    version: flags.version,
    description: flags.description,
    category: flags.category,
    model: flags.model,
    toolsets: splitList(flags.toolsets, ','),
    capabilities,
    skillDeps: [...requiredSkills, ...optionalSkills],
    tags: splitList(flags.tags, ','),
    useCases: splitList(flags['use-cases'], ';'),
    outcomeExamples: splitList(flags.outcomes, ';'),
    ...(humanMd != null ? { humanMd } : {}),
    persona,
    ...(extras?.visibility ? { visibility: extras.visibility } : {}),
  }
}

/** --visibility 只认 org(默认公开);别的值直接报错,防手滑静默变公开。 */
function parseVisibility(raw: string | undefined): 'org' | undefined {
  if (raw === undefined || raw === 'public') return undefined
  if (raw === 'org') return 'org'
  fail(`--visibility 只支持 org 或 public,收到 "${raw}"`)
}

async function call(
  method: 'GET' | 'POST',
  op: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<any> {
  const endpoint = resolveMarketplaceEndpoint()
  const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/${op}${qs}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    })
    const text = await res.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      const e = json?.error
      fail(
        `${res.status} ${e?.code ?? ''} ${e?.message ?? text}${json?.errors ? `\n- ${json.errors.join('\n- ')}` : ''}`,
      )
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

function fileArg(flags: Record<string, string>, key: string): string | undefined {
  const f = flags[key]
  if (!f) return undefined
  try {
    return readFileSync(f, 'utf8')
  } catch {
    fail(`cannot read ${key}: ${f}`)
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      'usage: oc-market <search|detail|installed|install|uninstall|publish-skill|publish-agent> ...\n',
    )
    process.exit(0)
  }
  const { positional, flags } = parseFlags(rest)
  const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)

  switch (cmd) {
    case 'search': {
      const q = positional.join(' ')
      const query: Record<string, string> = { q }
      if (flags.kind) query.kind = flags.kind === 'plugin' ? 'connector' : flags.kind
      const r = await call('GET', 'search', query)
      out(r.results ?? [])
      return
    }
    case 'detail': {
      const slug = positional[0] ?? flags.slug
      if (!slug) fail('detail <slug>')
      out((await call('GET', 'detail', { slug })).detail)
      return
    }
    case 'installed':
      out((await call('GET', 'installed')).installed ?? [])
      return
    case 'install': {
      const slug = positional[0] ?? flags.slug
      if (!slug) fail('install <slug>')
      out(await call('POST', 'install', undefined, { slug }))
      return
    }
    case 'uninstall': {
      const slug = positional[0] ?? flags.slug
      if (!slug) fail('uninstall <slug>')
      out(await call('POST', 'uninstall', undefined, { slug }))
      return
    }
    case 'publish-skill': {
      const body = fileArg(flags, 'body-file') ?? flags.body
      if (!body) fail('publish-skill needs --body-file <f>')
      let files: BundleFileEntry[] | undefined
      if (flags['bundle-dir']) {
        const collected = collectBundleDir(flags['bundle-dir'])
        if (collected.errors.length > 0)
          fail(`--bundle-dir 预检不通过:\n- ${collected.errors.join('\n- ')}`)
        files = collected.files
      }
      let benchmark: unknown
      const benchRaw = fileArg(flags, 'benchmark-file')
      if (benchRaw !== undefined) {
        try {
          benchmark = JSON.parse(benchRaw)
        } catch {
          fail('--benchmark-file 不是合法 JSON')
        }
      }
      out(
        await call(
          'POST',
          'publish',
          undefined,
          buildPublishSkillRequest(flags, body, fileArg(flags, 'intro-file'), {
            files,
            benchmark,
            visibility: parseVisibility(flags.visibility),
          }),
        ),
      )
      return
    }
    case 'publish-agent': {
      const persona = fileArg(flags, 'persona-file') ?? flags.persona
      if (!persona) fail('publish-agent needs --persona-file <f>')
      out(
        await call(
          'POST',
          'publish',
          undefined,
          buildPublishAgentRequest(flags, persona, fileArg(flags, 'intro-file'), {
            visibility: parseVisibility(flags.visibility),
          }),
        ),
      )
      return
    }
    default:
      fail(
        'usage: oc-market <search|detail|installed|install|uninstall|publish-skill|publish-agent> ...',
      )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
}
