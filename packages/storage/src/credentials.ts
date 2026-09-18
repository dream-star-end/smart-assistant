import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { paths } from './paths.js'

// 凭据存储:~/.openclaude/credentials/<channel>/<accountId>.json,文件权限 0600
//
// channel / accountId 直接拼进路径,必须是简单标识符(CFG-15):拒 `..`、分隔符、空串,
// 让路径穿越在入口就抛出,而不是依赖调用方永远传受控值。
const CREDENTIAL_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/

function credentialPath(channel: string, accountId: string): string {
  if (typeof channel !== 'string' || !CREDENTIAL_SEGMENT_RE.test(channel)) {
    throw new Error(
      `invalid credential channel ${JSON.stringify(channel)} (expected [A-Za-z0-9_-]{1,64})`,
    )
  }
  if (typeof accountId !== 'string' || !CREDENTIAL_SEGMENT_RE.test(accountId)) {
    throw new Error(
      `invalid credential accountId ${JSON.stringify(accountId)} (expected [A-Za-z0-9_-]{1,64})`,
    )
  }
  return join(paths.credentialsDir, channel, `${accountId}.json`)
}

export async function saveCredential(
  channel: string,
  accountId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const filePath = credentialPath(channel, accountId)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export async function readCredential<T = Record<string, unknown>>(
  channel: string,
  accountId: string,
): Promise<T | null> {
  const filePath = credentialPath(channel, accountId)
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
