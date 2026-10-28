import WebSocket from 'ws'

// A content final is not the durable turn outcome. Keep the listener installed until
// tape_commit, including when both frames arrive back-to-back in one socket read.
export function goCacheTurn({ base, token, peer, model, cmid, text, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/user-chat-bridge`, ['bearer', token])
    let done = false
    const timer = setTimeout(() => finish(new Error('turn did not commit')), timeout)
    function finish(error) {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.close()
      error ? reject(error) : resolve()
    }
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'inbound.message', channel: 'webchat', peer: { id: peer, kind: 'dm' },
      agentId: 'main', clientMessageId: cmid, content: { text }, model, ts: Date.now(),
    })))
    ws.on('message', (raw) => {
      let f
      try { f = JSON.parse(String(raw)) } catch { return }
      if (f?.peer?.id !== peer || f.clientMessageId !== cmid) return
      if (f.error || ['outbound.error', 'outbound.turn_error', 'error'].includes(f.type))
        finish(new Error(`turn failed: ${f.error?.code ?? f.code ?? f.type}`))
      else if (f.type === 'outbound.message' && f.isFinal === true && f.meta?.reconcileSource === 'tape_commit')
        f.meta.reconcile === 'turn_completed'
          ? finish()
          : finish(new Error(`turn committed as ${f.meta.reconcile ?? 'unknown'}`))
    })
    ws.on('error', () => finish(new Error('chat socket error')))
    ws.on('close', () => finish(new Error('chat socket closed before the committed turn')))
  })
}

// Wait only for accounting visibility, never resubmit a user turn. A successful
// terminal without its billed request remains a failure at the same bounded deadline.
export async function waitGoCacheUsage(readRow, turns, {
  attempts = 30, sleep = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
} = {}) {
  let row
  for (let i = 0; i < attempts; i++) {
    row = await readRow()
    const requests = Number(row?.requests ?? 0)
    if (Number.isFinite(requests) && requests >= turns) return row
    if (row && !Number.isFinite(requests)) throw new Error('usage row is not numeric')
    if (i + 1 < attempts) await sleep()
  }
  throw new Error(`expected ≥${turns} billed requests, got ${Number(row?.requests ?? 0)}`)
}
