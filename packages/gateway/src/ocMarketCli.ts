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
 *   oc-market publish-skill --slug <s> --name <n> --version <v> --description <d> --body-file <f> [--tags a,b]
 *   oc-market publish-agent --slug <s> --name <n> --version <v> --description <d> --model <m> --toolsets a,b --persona-file <f> [--skill-deps a,b] [--tags a,b]
 */
import { readFileSync } from 'node:fs'

function fail(msg: string): never {
  process.stderr.write(`oc-market: ${msg}\n`)
  process.exit(1)
}

function readContainerToken(): string {
  const tok = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (tok) return tok
  const file = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE?.trim()
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      fail('container token file unreadable')
    }
  }
  fail('not in a commercial container (no container token)')
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

async function call(
  method: 'GET' | 'POST',
  op: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<any> {
  const base = process.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  if (!base) fail('not in a commercial container (no master base url)')
  const token = readContainerToken()
  const qs = query ? `?${new URLSearchParams(query).toString()}` : ''
  const url = `${base.replace(/\/+$/, '')}/internal/v3/marketplace/agent/${op}${qs}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
        await call('POST', 'publish', undefined, {
          kind: 'skill',
          slug: flags.slug,
          name: flags.name,
          version: flags.version,
          description: flags.description,
          tags: flags.tags
            ? flags.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          body,
        }),
      )
      return
    }
    case 'publish-agent': {
      const persona = fileArg(flags, 'persona-file') ?? flags.persona
      if (!persona) fail('publish-agent needs --persona-file <f>')
      out(
        await call('POST', 'publish', undefined, {
          kind: 'agent',
          slug: flags.slug,
          name: flags.name,
          version: flags.version,
          description: flags.description,
          model: flags.model,
          toolsets: flags.toolsets
            ? flags.toolsets
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          skillDeps: flags['skill-deps']
            ? flags['skill-deps']
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          tags: flags.tags
            ? flags.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
          persona,
        }),
      )
      return
    }
    default:
      fail(
        'usage: oc-market <search|detail|installed|install|uninstall|publish-skill|publish-agent> ...',
      )
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
