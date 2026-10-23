/** Read-only, bounded plain/gzip log scan; no shell, credentials or raw I/O errors in output. */
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { type Source, type TraceEvent, eventFromLogLine, toIso } from './ocTraceLib.ts'

export interface LogLocation {
  source: Source
  dir: string
  pattern: RegExp
}
export interface LogWindow {
  source: Source
  file: string
  first: string | null
  last: string | null
  complete: boolean
}
export interface LogReadResult {
  events: TraceEvent[]
  truncated: boolean
  errors: string[]
  windows: LogWindow[]
}

export async function readLogEvents(
  ids: Set<string>,
  locations: LogLocation[],
  deadline: number,
  lineCap = 5000,
): Promise<LogReadResult> {
  const needles = [...ids]
  const result: LogReadResult = {
    events: [],
    truncated: false,
    errors: [],
    windows: [],
  }
  for (const { source, dir, pattern } of locations) {
    let files: string[]
    try {
      files = (await readdir(dir)).filter((name) => pattern.test(name)).sort()
    } catch {
      result.errors.push(`${source}:directory-unreadable`)
      continue
    }
    for (const file of files) {
      const window: LogWindow = {
        source,
        file,
        first: null,
        last: null,
        complete: false,
      }
      result.windows.push(window)
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        result.errors.push(`${source}:scan-deadline`)
        return result
      }
      const raw = createReadStream(path.join(dir, file), {
        encoding: undefined,
      })
      const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
      if (input !== raw) raw.on('error', (error) => input.destroy(error))
      const lines = createInterface({
        input,
        crlfDelay: Number.POSITIVE_INFINITY,
      })
      const timer = setTimeout(() => input.destroy(new Error('scan-deadline')), remaining)
      try {
        for await (const line of lines) {
          if (Date.now() >= deadline) {
            result.errors.push(`${source}:scan-deadline`)
            return result
          }
          let at: string | undefined
          try {
            const json = line.startsWith('{') ? line : line.replace(/^\d{4}-\d\d-\d\dT\S+Z /, '')
            const record = JSON.parse(json)
            at = typeof record?.ts === 'string' ? toIso(record.ts) : undefined
          } catch {
            // Plain stack lines and non-JSON runtime output have no structured timestamp.
          }
          if (at) {
            if (window.first === null || at < window.first) window.first = at
            if (window.last === null || at > window.last) window.last = at
          }
          if (!needles.some((id) => line.includes(id))) continue
          const event = eventFromLogLine(source, line)
          // An id mentioned only in free text or a session key is not an association.
          if (
            !event ||
            !Object.entries(event.ids).some(([key, id]) => key !== 'sessionKey' && ids.has(id))
          )
            continue
          if (result.events.length >= lineCap) result.truncated = true
          else result.events.push(event)
        }
        window.complete = true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        result.errors.push(`${source}:${file}:${code || 'read-failed'}`)
      } finally {
        clearTimeout(timer)
        lines.close()
        input.destroy()
        raw.destroy()
      }
    }
  }
  return result
}
