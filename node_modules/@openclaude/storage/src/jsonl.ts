import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// 追加式 JSONL 会话日志(crash-safe,最坏只丢一行)
export class JsonlLog {
  constructor(private filePath: string) {}

  async append(entry: unknown): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`)
  }

  async readAll(): Promise<unknown[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const lines = raw.split('\n').filter(Boolean)
      const out: unknown[] = []
      for (const line of lines) {
        try {
          out.push(JSON.parse(line))
        } catch {
          // 损坏行跳过
        }
      }
      return out
    } catch (err: any) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }
}
