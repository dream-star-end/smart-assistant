import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
// Real ModelSelector + trusted Chromium clicks. This is NOT a full App/login/live test.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { launchJourneyBrowser, selectJourneyModel } from '../../../scripts/lib/journey-browser.mjs'
const { build } = createRequire(import.meta.url)('esbuild')
// 93696701d moved the selfhost contract smoke to a visible gpt-6-luna (requireCollapsed: false); after
// 573b7c88b no selfhost family is collapsed, so the old GPT-5.6 collapsed-group proof had no members (OCV5-355).
test('R2 real picker selects exact visible model (shared deployment helper)', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./user-contract-harness.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
      '@openclaude/protocol': fileURLToPath(
        new URL('../../protocol/src/index.ts', import.meta.url),
      ),
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  })
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await selectJourneyModel(page, 'gpt-6-luna', { requireCollapsed: false })
    assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-6-luna')
    assert.equal(await page.locator('[data-collapsed-group]').count(), 0, 'selfhost has no default-collapsed family')
    // A fresh mount still reaches the same exact row through the shared helper.
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await selectJourneyModel(page, 'gpt-6-luna', { requireCollapsed: false })
    assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-6-luna')
  } finally {
    await browser.close()
  }
})

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// Synthetic HTTP/WS backend: validates the gate runner, not production auth/engine integration.
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { WebSocketServer } = createRequire(import.meta.url)('ws')
const fixtureHtml = `<!doctype html><body><div id="app"><button id="login">登录</button></div>
<script>
const app=document.querySelector('#app');let model='glm-5.3',peer=0,ws;
document.querySelector('#login').onclick=()=>{app.innerHTML='<form><input type="email"><input type="password"><button>登录</button></form>';document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();if(localStorage.getItem('oc_auth_hint'))throw Error('unexpected hint');await fetch('/api/auth/login',{method:'POST',body:'{}'});localStorage.setItem('oc_auth_hint','1');await fetch('/api/public/models');ws=new WebSocket('ws://'+location.host+'/ws/user-chat-bridge');ws.onmessage=(e)=>{const f=JSON.parse(e.data);if(f.type==='outbound.message'){document.querySelector('#answer').innerHTML='<div data-testid="assistant-row"><div class="prose">2</div></div>'}};app.innerHTML='<button id="new">新建会话</button><div id="chat"></div>';document.querySelector('#new').onclick=newSession;};};
function newSession(){peer++;document.querySelector('#chat').innerHTML='<button aria-label="选择对话模型" id="model">'+model+'</button><div id="menu"></div><textarea></textarea><button aria-label="发送" id="send">发送</button><div id="answer"></div>';document.querySelector('#model').onclick=()=>{document.querySelector('#menu').innerHTML='<div role="menu"><button data-model-id="gpt-6-luna">gpt-6-luna</button><button data-model-id="grok-build">grok-build</button><button data-model-id="deepseek-v4-flash">deepseek-v4-flash</button></div>';bindModels();};document.querySelector('#send').onclick=async()=>{await fetch('/api/sessions/'+peer,{method:'PUT',body:JSON.stringify({modelId:model})});const f={type:'inbound.message',peer:{id:String(peer)},clientMessageId:crypto.randomUUID(),model,content:{text:document.querySelector('textarea').value}};if(ws.readyState!==1)await new Promise(r=>ws.addEventListener('open',r,{once:true}));ws.send(JSON.stringify(f));};}
function bindModels(){for(const b of document.querySelectorAll('[data-model-id]'))b.onclick=()=>{model=b.dataset.modelId;document.querySelector('#model').textContent=model;document.querySelector('#menu').innerHTML='';};}
</script>`
for (const cost of ['dry', 'live'])
  test(`R2 synthetic runner C1-C3 ${cost} forwarding and timings`, async () => {
    const calls = []
    const server = createServer((req, res) => {
      res.setHeader(
        'Content-Type',
        req.url.startsWith('/api/')
          ? 'application/json; charset=utf-8'
          : 'text/html; charset=utf-8',
      )
      if (req.url === '/api/public/models')
        res.end(
          JSON.stringify({
            models: [
              // Mirrors the smoke defaults the selfhost deploy gate uses: C2 gpt-6-luna, C3 grok-build + deepseek-v4-flash.
              { id: 'gpt-6-luna', engine: 'codex' },
              { id: 'grok-build', engine: 'grok' },
              { id: 'deepseek-v4-flash', engine: 'ccb' },
            ],
          }),
        )
      else if (req.url.startsWith('/api/')) res.end('{}')
      else res.end(fixtureHtml)
    })
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw))
        calls.push(f)
        ws.send(
          JSON.stringify({
            type: 'outbound.message',
            peer: f.peer,
            clientMessageId: f.clientMessageId,
            isFinal: true,
            text: '2',
          }),
        )
      }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'r2-contract-fixture-'))
    writeFileSync(join(dir, 'password'), 'fixture-only', { mode: 0o600 })
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../../../scripts/v5-user-contract-smoke.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            V5_E2E_BASE: `http://127.0.0.1:${server.address().port}`,
            V5_CANARY_PASSWORD_FILE: join(dir, 'password'),
            V5_CONTRACT_COST: cost,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (d) => (output += d))
      child.stderr.on('data', (d) => (output += d))
      const code = await new Promise((resolve) => child.on('exit', resolve))
      assert.equal(code, 0, output)
      assert.equal((output.match(/^ok [123] -/gm) ?? []).length, 3, output)
      assert.match(output, /# timings_ms \[\d+,\d+,\d+\]/)
      assert.deepEqual(
        calls.map((f) => f.model),
        cost === 'dry' ? [] : ['grok-build', 'deepseek-v4-flash'],
      )
      console.log(`# synthetic-${cost} ${output.match(/# timings_ms .*/)?.[0]}`)
    } finally {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    }
  })
