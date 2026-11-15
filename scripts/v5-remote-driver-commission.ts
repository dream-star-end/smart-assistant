#!/usr/bin/env npx tsx
/**
 * Operator CLI client for `remote-driver-v4` commissioning, cutover, policy management,
 * reverification, and rollback (`OCV5-749`, R12).
 *
 * Security:
 * - Only HTTPS or loopback HTTP (`127.0.0.1` / `localhost` / `[::1]`) allowed
 * - Validates `--token-file` is a regular 0600 file owned by current UID
 * - Sends `redirect: 'manual'` (never leaks Bearer token on redirects)
 */
import { lstatSync, readFileSync } from 'node:fs'

const UUID_RE = /^[a-f0-9-]{36}$/i

function fail(msg: string): never {
  process.stderr.write(`${msg}
`)
  process.exit(2)
}

function validateUrl(rawUrl: string): URL {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    fail(`Invalid --url: ${rawUrl}`)
  }
  if (u.username || u.password || u.search || u.hash) {
    fail('URL must not contain credentials, query string, or fragment')
  }
  const host = u.hostname.toLowerCase()
  const loopback =
    host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    fail('HTTPS or loopback HTTP required')
  }
  return u
}

function readTokenFile(tokenFile: string): string {
  const st = lstatSync(tokenFile)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0) {
    fail(`Unsafe token file permissions (require 0600 regular file): ${tokenFile}`)
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    fail(`Unsafe token file owner: ${tokenFile}`)
  }
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!token) fail('Empty token file')
  return token
}

async function apiJson(
  baseUrl: URL,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const target = new URL(path, baseUrl)
  const res = await fetch(target.toString(), {
    method,
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refused HTTP redirect (${res.status})`)
  }
  const text = await res.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(parsed)}`)
  }
  return { status: res.status, json: parsed }
}

function parseArgs(argv: string[]) {
  let urlStr = ''
  let tokenFile = ''
  let wait = false
  let profileId = ''
  let driverId: string | undefined
  let deadlineMs: number | undefined
  let maxCreditsPerRun: number | undefined
  let maxCreditsPerDay: number | undefined
  let maxPaidTurnsPerRun: number | undefined
  let autoVerifyEnabled: boolean | undefined

  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--url' && argv[i + 1]) urlStr = argv[++i]!
    else if (a === '--token-file' && argv[i + 1]) tokenFile = argv[++i]!
    else if (a === '--profile-id' && argv[i + 1]) profileId = argv[++i]!
    else if (a === '--driver' && argv[i + 1]) driverId = argv[++i]!
    else if (a === '--deadline-ms' && argv[i + 1]) deadlineMs = Number(argv[++i]!)
    else if (a === '--max-credits-per-run' && argv[i + 1]) maxCreditsPerRun = Number(argv[++i]!)
    else if (a === '--max-credits-per-day' && argv[i + 1]) maxCreditsPerDay = Number(argv[++i]!)
    else if (a === '--max-paid-turns-per-run' && argv[i + 1])
      maxPaidTurnsPerRun = Number(argv[++i]!)
    else if (a === '--auto-verify-enabled' && argv[i + 1]) autoVerifyEnabled = argv[++i]! === 'true'
    else if (a === '--wait') wait = true
    else if (!a.startsWith('-')) positional.push(a)
    else fail(`Unknown flag: ${a}`)
  }

  const subcommand = positional[0]
  if (!subcommand)
    fail('Subcommand required: policy-get|policy-set|cutover|reverify|revert|profile-status')
  if (!urlStr || !tokenFile) fail('--url and --token-file are required')

  return {
    subcommand,
    url: validateUrl(urlStr),
    token: readTokenFile(tokenFile),
    wait,
    profileId,
    driverId,
    deadlineMs,
    maxCreditsPerRun,
    maxCreditsPerDay,
    maxPaidTurnsPerRun,
    autoVerifyEnabled,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = '/api/admin/remote-pool/driver-v4'

  if (args.subcommand === 'policy-get') {
    const { json } = await apiJson(args.url, args.token, 'GET', `${base}/policy`)
    process.stdout.write(`${JSON.stringify(json, null, 2)}
`)
    return
  }

  if (args.subcommand === 'policy-set') {
    const patch: Record<string, unknown> = {}
    if (args.maxCreditsPerRun !== undefined) patch.maxCreditsPerRun = args.maxCreditsPerRun
    if (args.maxCreditsPerDay !== undefined) patch.maxCreditsPerDay = args.maxCreditsPerDay
    if (args.maxPaidTurnsPerRun !== undefined) patch.maxPaidTurnsPerRun = args.maxPaidTurnsPerRun
    if (args.autoVerifyEnabled !== undefined) patch.autoVerifyEnabled = args.autoVerifyEnabled
    const { json } = await apiJson(args.url, args.token, 'POST', `${base}/policy`, patch)
    process.stdout.write(`${JSON.stringify(json, null, 2)}
`)
    return
  }

  if (!UUID_RE.test(args.profileId)) {
    fail('--profile-id <uuid> is required')
  }

  if (args.subcommand === 'profile-status') {
    const { json } = await apiJson(
      args.url,
      args.token,
      'GET',
      `${base}/profiles/${args.profileId}`,
    )
    process.stdout.write(`${JSON.stringify(json, null, 2)}
`)
    return
  }

  if (args.subcommand === 'revert') {
    const { json } = await apiJson(args.url, args.token, 'POST', `${base}/revert`, {
      profileId: args.profileId,
    })
    process.stdout.write(`${JSON.stringify(json, null, 2)}
`)
    return
  }

  if (args.subcommand === 'cutover' || args.subcommand === 'reverify') {
    const endpoint = args.subcommand === 'cutover' ? `${base}/cutover` : `${base}/reverify`
    const payload: Record<string, unknown> = {
      profileId: args.profileId,
      ...(args.driverId ? { driverId: args.driverId } : {}),
      ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
      ...(args.maxCreditsPerRun !== undefined ? { maxCreditsPerRun: args.maxCreditsPerRun } : {}),
      ...(args.maxCreditsPerDay !== undefined ? { maxCreditsPerDay: args.maxCreditsPerDay } : {}),
    }
    const { json: initial } = await apiJson(args.url, args.token, 'POST', endpoint, payload)
    if (!args.wait) {
      process.stdout.write(`${JSON.stringify(initial, null, 2)}
`)
      return
    }
    const jobId = String(initial.jobId ?? '')
    while (true) {
      await new Promise((r) => setTimeout(r, 3000))
      const { json: job } = await apiJson(args.url, args.token, 'GET', `${base}/jobs/${jobId}`)
      if (job.status === 'passed') {
        process.stdout.write(`${JSON.stringify(job, null, 2)}
`)
        return
      }
      if (job.status === 'reverted' || job.status === 'failed') {
        process.stdout.write(`${JSON.stringify(job, null, 2)}
`)
        process.exit(1)
      }
    }
  }

  fail(`Unsupported subcommand: ${args.subcommand}`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`)
  process.exit(1)
})
