/**
 * oc-market — in-container CLI the AI uses to operate the AI marketplace on the
 * user's behalf. Talks to master's /internal/v3/marketplace/agent/* with the
 * container token (same transport as the hub sync). Every op is scoped to this
 * container's user by the server; install is limited to admin-approved content;
 * publish goes to the review queue (never live without admin approval).
 *
 * Usage (the `market` baseline skill documents this for the agent):
 *   oc-market search <query> [--kind skill|agent]
 *   oc-market detail <slug>
 *   oc-market installed
 *   oc-market install <slug>
 *   oc-market uninstall <slug>
 *   oc-market publish-skill --slug <s> --name <n> --version <v> --description <d> --body-file <f>
 *     --category <id> --use-cases "a;b" [--outcomes "a;b"] [--intro-file <f>] [--tags a,b]
 *   oc-market publish-agent --slug <s> --name <n> --version <v> --description <d> --model <m>
 *     --toolsets a,b --persona-file <f> --category <id> --use-cases "a;b"
 *     [--outcomes "a;b"] [--intro-file <f>] [--skill-deps a,b] [--tags a,b]
 *
 * Storefront ("人向商品层") metadata carried on publish (validated server-side):
 *   --category <id>       one of the marketplace taxonomy ids (required)
 *   --use-cases "a;b"     1-4 "what the user wants to do" sentences, ';'-separated (required)
 *   --outcomes "a;b"      0-4 concrete "give X → get Y" effect examples, ';'-separated (optional)
 *   --intro-file <f>      Markdown rich intro rendered on the storefront page (optional) → humanMd
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
    const cfg = JSON.parse(readFile(join(home, 'openclaude.json'), 'utf8')) as { gateway?: { port?: unknown } }
    const port = typeof cfg.gateway?.port === 'number' ? cfg.gateway.port : Number(cfg.gateway?.port)
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
  if (masterBase) throw new Error('not in a commercial container (no container token and no local gateway config)')
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
  skillDeps: string[]
  tags: string[]
  useCases: string[]
  outcomeExamples: string[]
  humanMd?: string
  persona: string
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
  }
}

/** Assemble the publish-agent request body (same storefront metadata as skills). */
export function buildPublishAgentRequest(
  flags: Record<string, string>,
  persona: string,
  humanMd?: string,
): PublishAgentRequest {
  return {
    kind: 'agent',
    slug: flags.slug,
    name: flags.name,
    version: flags.version,
    description: flags.description,
    category: flags.category,
    model: flags.model,
    toolsets: splitList(flags.toolsets, ','),
    skillDeps: splitList(flags['skill-deps'], ','),
    tags: splitList(flags.tags, ','),
    useCases: splitList(flags['use-cases'], ';'),
    outcomeExamples: splitList(flags.outcomes, ';'),
    ...(humanMd != null ? { humanMd } : {}),
    persona,
  }
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
  const { positional, flags } = parseFlags(rest)
  const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)

  switch (cmd) {
    case 'search': {
      const q = positional.join(' ')
      const query: Record<string, string> = { q }
      if (flags.kind) query.kind = flags.kind
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
      out(
        await call(
          'POST',
          'publish',
          undefined,
          buildPublishSkillRequest(flags, body, fileArg(flags, 'intro-file')),
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
          buildPublishAgentRequest(flags, persona, fileArg(flags, 'intro-file')),
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
