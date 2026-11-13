/** Real filesystem scan plus HTTP on the same event loop; synthetic data only. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanJsonlTree } from '../packages/gateway/src/uploadRetention.js'

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'upload-retention-http-proof-'))
  let phase = 'idle'
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ phase }))
  })
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight: Promise<void> | null = null
  let probeFailure: unknown
  let during = 0
  let maxLatencyMs = 0
  try {
    const padding = 'x'.repeat(64 * 1024)
    for (let dir = 0; dir < 96; dir++) {
      const path = join(root, `d${dir}`)
      await mkdir(path)
      for (let file = 0; file < 20; file++) {
        const hash = createHash('sha256').update(`${dir}/${file}`).digest('hex')
        await writeFile(join(path, `${file}.jsonl`), `${padding} /api/media/${hash}.txt\n`)
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    const probe = () => new Promise<{ phase: string; latencyMs: number }>((resolve, reject) => {
      const started = performance.now()
      const req = get({ hostname: '127.0.0.1', port, path: '/healthz', agent: false }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', text => { body += text })
        res.on('error', reject)
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP proof status=${res.statusCode}`)); return }
          try {
            resolve({ phase: (JSON.parse(body) as { phase: string }).phase, latencyMs: performance.now() - started })
          } catch (error) { reject(error) }
        })
      })
      req.setTimeout(1000, () => req.destroy(new Error('HTTP proof timeout')))
      req.once('error', reject)
    })
    await probe()
    phase = 'scanning'
    timer = setInterval(() => {
      if (inFlight) return
      inFlight = probe().then(result => {
        if (result.phase === 'scanning') {
          during++
          maxLatencyMs = Math.max(maxLatencyMs, result.latencyMs)
        }
      }).catch(error => { probeFailure = error }).finally(() => { inFlight = null })
    }, 10)
    const names = new Set<string>()
    const complete = await scanJsonlTree(root, names)
    phase = 'done'
    clearInterval(timer)
    await inFlight
    assert.equal(complete, true, 'HTTP proof requires a complete scan')
    assert.equal(names.size, 1920, 'HTTP proof must read every synthetic reference')
    assert.equal(probeFailure, undefined, 'HTTP probes must all succeed')
    assert.ok(during > 0, 'HTTP must respond during the scan')
    assert.ok(maxLatencyMs < 1000, `HTTP response latency ${maxLatencyMs.toFixed(1)}ms must be below 1000ms`)
    console.log(`UPLOAD_RETENTION_HTTP_RESPONSIVE files=1920 during=${during} maxLatencyMs=${maxLatencyMs.toFixed(1)}`)
  } finally {
    phase = 'done'
    if (timer) clearInterval(timer)
    await inFlight
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

await main()
