import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { paths } from './paths.js'

// 凭据存储:~/.openclaude/credentials/<channel>/<accountId>.json,文件权限 0600
export async function saveCredential(
  channel: string,
  accountId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const filePath = join(paths.credentialsDir, channel, `${accountId}.json`)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export async function readCredential<T = Record<string, unknown>>(
  channel: string,
  accountId: string,
): Promise<T | null> {
  try {
    const filePath = join(paths.credentialsDir, channel, `${accountId}.json`)
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err: any) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
