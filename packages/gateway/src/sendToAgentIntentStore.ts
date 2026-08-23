import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

export interface SendToAgentIntent {
  v: 1
  jobId: string
  originSessionKey: string
  userId?: string
  agentId: string
  goal: string
  createdAt: number
}

const JOB_RE = /^dlgjob-[A-Za-z0-9-]{1,160}$/

function intentDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR?.trim()) {
    return env.OPENCLAUDE_SEND_TO_AGENT_INTENT_DIR.trim()
  }
  const home = env.OPENCLAUDE_HOME?.trim() || join(homedir(), '.openclaude')
  return join(home, 'runtime', 'send-to-agent-intents')
}

function intentPath(jobId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!JOB_RE.test(jobId)) throw new Error('invalid send_to_agent job id')
  return join(intentDir(env), `${jobId}.json`)
}

export async function persistSendToAgentIntent(
  intent: SendToAgentIntent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = intentPath(intent.jobId, env)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(intent)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
    await chmod(path, 0o600).catch(() => {})
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

export async function removeSendToAgentIntent(
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(intentPath(jobId, env), { force: true })
}

function parseIntent(raw: string): SendToAgentIntent | null {
  try {
    const value = JSON.parse(raw) as Partial<SendToAgentIntent>
    if (
      value.v !== 1 || !JOB_RE.test(String(value.jobId ?? '')) ||
      typeof value.originSessionKey !== 'string' || !value.originSessionKey ||
      typeof value.agentId !== 'string' || !value.agentId ||
      typeof value.goal !== 'string' || typeof value.createdAt !== 'number'
    ) return null
    return value as SendToAgentIntent
  } catch {
    return null
  }
}

/**
 * A leftover intent means the old process never confirmed callback delivery.
 * Recovery deliberately emits a terminal notice only; it never re-dispatches a
 * model turn, avoiding duplicate execution after an unknown crash boundary.
 */
export async function recoverInterruptedSendToAgentIntents(
  deliver: (intent: SendToAgentIntent) => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ recovered: number; retained: number; malformed: number }> {
  const dir = intentDir(env)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { recovered: 0, retained: 0, malformed: 0 }
    throw err
  }
  let recovered = 0
  let retained = 0
  let malformed = 0
  for (const name of names.sort()) {
    if (!/^dlgjob-[A-Za-z0-9-]{1,160}\.json$/.test(name)) continue
    const path = join(dir, name)
    const intent = parseIntent(await readFile(path, 'utf8').catch(() => ''))
    if (!intent) {
      malformed += 1
      await rm(path, { force: true }).catch(() => {})
      continue
    }
    try {
      if (await deliver(intent)) {
        await rm(path, { force: true })
        recovered += 1
      } else {
        retained += 1
      }
    } catch {
      retained += 1
    }
  }
  return { recovered, retained, malformed }
}
