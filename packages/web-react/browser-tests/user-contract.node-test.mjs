import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
// Real ModelSelector + trusted Chromium clicks. This is NOT a full App/login/live test.
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { cpSync, copyFileSync, readFileSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchJourneyBrowser, selectJourneyModel } from '../../../scripts/lib/journey-browser.mjs'
const { build } = createRequire(import.meta.url)('esbuild')
const authorityPath = fileURLToPath(new URL('../../protocol/src/engineModels.ts', import.meta.url))
const sha = (text) => createHash('sha256').update(text).digest('hex')
const legacyBlocks = ["  {\n    family: 'gpt-5.6-sol',\n    familyLabel: 'GPT-5.6-Sol',\n    standardId: 'gpt-5.6-sol',\n    longId: 'gpt-5.6-sol-1m',\n    collapsedByDefault: false,\n  },\n", "  {\n    family: 'gpt-5.6-terra',\n    familyLabel: 'GPT-5.6-Terra',\n    standardId: 'gpt-5.6-terra',\n    longId: 'gpt-5.6-terra-1m',\n    collapsedByDefault: true,\n  },\n", "  {\n    family: 'gpt-5.6-luna',\n    familyLabel: 'GPT-5.6-Luna',\n    standardId: 'gpt-5.6-luna',\n    longId: 'gpt-5.6-luna-1m',\n    collapsedByDefault: true,\n  },\n"]
async function pickerBundle() {
  const source = await readFile(authorityPath, 'utf8')
  const negative = process.env.OC_LEGACY_CONTEXT_RED === '1'
  let replacements = 0, bundledSource = source
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./user-contract-harness.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
      '@openclaude/protocol/browser': fileURLToPath(
        new URL('../../protocol/src/browser.ts', import.meta.url),
      ),
      '@openclaude/protocol': fileURLToPath(
        new URL('../../protocol/src/index.ts', import.meta.url),
      ),
    },
    plugins: negative ? [{ name: 'remove-only-commercial-legacy-context', setup(api) {
      api.onLoad({ filter: /[\/]engineModels\.tsx?$/ }, async ({ path }) => {
        assert.equal(path, authorityPath)
        const current = await readFile(path, 'utf8')
        assert.equal(current, source)
        bundledSource = current
        for (const block of legacyBlocks) {
          assert.equal(bundledSource.split(block).length - 1, 1, 'exactly one restored legacy family')
          bundledSource = bundledSource.replace(block, '')
          replacements++
        }
        return { contents: bundledSource, loader: 'ts', resolveDir: dirname(path) }
      })
    }}] : [],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  })
  assert.equal(replacements, negative ? 3 : 0)
  assert.equal(await readFile(authorityPath, 'utf8'), source, 'in-memory negative control leaves authority unchanged')
  console.log('legacy-context-evidence ' + JSON.stringify({ negative, replacements, sourceSha: sha(source), bundledSha: sha(bundledSource) }))
  return bundle
}
test('R2 real collapsed picker selects exact model (shared deployment helper)', async () => {
  const bundle = await pickerBundle()
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await selectJourneyModel(page, 'gpt-5.6-luna', { requireCollapsed: true })
    assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-5.6-luna')
    // A new component mount must start collapsed (selected Luna correctly auto-opens on reopen).
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await selectJourneyModel(page, 'gpt-5.6-luna', { requireCollapsed: true })
  } finally {
    await browser.close()
  }
})

test('legacy commercial 1M selection requires real cancel or confirmation', async () => {
  const bundle = await pickerBundle()
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const selectLong = async () => {
      await page.getByRole('button', { name: '选择对话模型' }).click()
      await page.getByRole('menu').waitFor()
      const long = page.locator('[data-context="1m"]')
      assert.equal(await long.count(), 1, 'legacy selected family must offer exactly one 1M choice')
      await long.click()
      await page.getByRole('dialog').waitFor()
      assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-5.6-sol', 'no selection before consent')
    }
    await selectLong()
    await page.getByRole('button', { name: '保留标准', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-5.6-sol', 'cancel preserves standard model')
    await selectLong()
    await page.getByRole('button', { name: '仍要切换', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.querySelector('[data-testid="selected-model"]')?.textContent === 'gpt-5.6-sol-1m')
    assert.equal(await page.getByTestId('selected-model').textContent(), 'gpt-5.6-sol-1m', 'only confirmation selects long model')
  } finally { await browser.close() }
})

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
// Synthetic HTTP/WS backend: validates the gate runner, not production auth/engine integration.
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
const { WebSocketServer } = createRequire(import.meta.url)('ws')
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const legacySource = join(repoRoot, 'scripts/__tests__/fixtures/model-policy/legacy-9826')
const legacySha = '9826fe9512f6c2e2a9479d2db7faa55dd4515ac2'
function legacyRunner(dir) {
  const release = join(dir, 'legacy-release')
  // Share the browser helpers, but retain the actual historical option/parser and entry scripts.
  cpSync(join(repoRoot, 'scripts/lib'), join(release, 'scripts/lib'), {
    recursive: true, filter: (path) => basename(path) !== 'selfhost-model-policy.mjs',
  })
  for (const [file, sha] of [
    ['lib/user-contract.mjs', '5ca7dc45dbf863706589fda68024b8ef254b954aa20a0fb60b839ec6576fbabf'],
    ['v5-user-contract-prewarm.mjs', 'ca71903e8e8a048caa7db16c03186e63d2d7e70afecc8b017778c2e26b5b0b9c'],
    ['v5-user-contract-smoke.mjs', 'ad292d858bbf0dd28421af61d96c6ce65c2d5f78dd309a1c42c3cdfe9afa09f6'],
  ]) {
    const fixture = join(legacySource, 'scripts', `${file}.txt`)
    assert.equal(createHash('sha256').update(readFileSync(fixture)).digest('hex'), sha)
    copyFileSync(fixture, join(release, 'scripts', file))
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(release, 'node_modules'), 'dir')
  writeFileSync(join(release, 'package.json'), '{"type":"module"}')
  writeFileSync(join(release, '.complete'), JSON.stringify({ sourceCommit: legacySha }))
  // Static/digest rejection is exercised separately by the private-filesystem recovery proof.
  // Here the real selector must bind the known recovery identity and choose the frozen child.
  const selected = JSON.parse(execFileSync('bash', ['-c', String.raw`
    set -euo pipefail
    source "$MODEL_POLICY_LIB"
    CUTOVER_ROLLBACK=1; ROLLBACK_MASTER="$TEST_RELEASE"; ROLLBACK_SHA="$TEST_SHA"
    assert_master_release_static_gate() { [[ "$1" == "$TEST_RELEASE" && "$2" == "$TEST_SHA" ]]; }
    model_policy_select_contract_runner "$TEST_RELEASE" rollback
    jq -nc --arg directory "$MODEL_POLICY_CONTRACT_DIR" --arg models "$MODEL_POLICY_CONTRACT_MODELS" '{directory:$directory,models:$models}'
  `], {
    encoding: 'utf8', env: { ...process.env, SCRIPT_DIR: join(repoRoot, 'scripts'),
      MODEL_POLICY_LIB: join(repoRoot, 'scripts/lib/v5-selfhost-model-policy.sh'),
      TEST_RELEASE: release, TEST_SHA: legacySha },
  }))
  assert.equal(selected.directory, join(release, 'scripts'))
  assert.equal(selected.models, 'gpt-6-luna,deepseek-v4-flash')
  return { entry: join(selected.directory, 'v5-user-contract-smoke.mjs'), models: selected.models }
}
const fixtureHtml = (grokEnabled) => `<!doctype html><body><div id="app"><button id="login">登录</button></div>
<script>
const app=document.querySelector('#app');let model='gpt-5.6-sol',peer=0,ws;
document.querySelector('#login').onclick=()=>{app.innerHTML='<form><input type="email"><input type="password"><button>登录</button></form>';document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();if(localStorage.getItem('oc_auth_hint'))throw Error('unexpected hint');await fetch('/api/auth/login',{method:'POST',body:'{}'});localStorage.setItem('oc_auth_hint','1');await fetch('/api/public/models');ws=new WebSocket('ws://'+location.host+'/ws/user-chat-bridge');ws.onmessage=(e)=>{const f=JSON.parse(e.data);if(f.type==='outbound.message'){const row=document.createElement('div');row.dataset.testid='assistant-row';row.innerHTML='<div class="prose"></div>';row.firstChild.textContent=f.text;document.querySelector('#answer').append(row)}};app.innerHTML='<button id="new">新建会话</button><div id="chat"></div>';document.querySelector('#new').onclick=newSession;};};
function newSession(){peer++;document.querySelector('#chat').innerHTML='<button aria-label="选择对话模型" id="model">'+model+'</button><div id="menu"></div><textarea></textarea><button aria-label="发送" id="send">发送</button><div id="answer"></div>';document.querySelector('#model').onclick=()=>{document.querySelector('#menu').innerHTML='<div role="menu"><button data-model-id="gpt-6-luna"><span class="truncate">gpt-6-luna</span></button>${grokEnabled ? '<button data-model-id="grok-build"><span class="truncate">grok-build</span></button>' : ''}<button data-model-id="deepseek-v4-flash"><span class="truncate">deepseek-v4-flash</span></button></div>';bindModels();};document.querySelector('#send').onclick=async()=>{await fetch('/api/sessions/'+peer,{method:'PUT',body:JSON.stringify({modelId:model})});const f={type:'inbound.message',peer:{id:String(peer)},clientMessageId:crypto.randomUUID(),model,content:{text:document.querySelector('textarea').value}};if(ws.readyState!==1)await new Promise(r=>ws.addEventListener('open',r,{once:true}));ws.send(JSON.stringify(f));};}
function bindModels(){for(const b of document.querySelectorAll('[data-model-id]'))b.onclick=()=>{model=b.dataset.modelId;document.querySelector('#model').textContent=model;document.querySelector('#menu').innerHTML='';};}
</script>`
for (const artifact of [false, true, 'legacy'])
for (const cost of ['dry', 'live'])
  test(`R2 synthetic runner C1-C3 grok=${artifact} ${cost} forwarding and timings`, async () => {
    const grokEnabled = artifact !== false
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
              // The fixture follows each explicit release policy, including restoration.
              { id: 'gpt-6-luna', engine: 'codex' },
              { id: 'grok-build', engine: 'grok' },
              { id: 'deepseek-v4-flash', engine: 'ccb' },
            ].filter((model) => grokEnabled || model.engine !== 'grok'),
          }),
        )
      else if (req.url.startsWith('/api/')) res.end('{}')
      else res.end(fixtureHtml(grokEnabled))
    })
    const wss = new WebSocketServer({ server })
    // Per-session memory like a real backend: the C3 continuation turn (OCV5-405) must
    // recall the code planted in the first turn of the same peer.
    const codes = new Map()
    wss.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw))
        calls.push(f)
        const planted = /编号是 PO-([A-Z]{4}[0-9]{4})/.exec(f.content.text)
        if (planted) codes.set(f.peer.id, planted[1])
        ws.send(
          JSON.stringify({
            type: 'outbound.message',
            peer: f.peer,
            clientMessageId: f.clientMessageId,
            isFinal: true,
            text: planted ? '收到' : `编号是 PO-${codes.get(f.peer.id) ?? '未知'}`,
          }),
        )
      }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'r2-contract-fixture-'))
    writeFileSync(join(dir, 'password'), 'fixture-only', { mode: 0o600 })
    writeFileSync(join(dir, 'model-availability.json'), JSON.stringify({ grokEnabled }))
    try {
      const runner = artifact === 'legacy' ? legacyRunner(dir) : {
        entry: fileURLToPath(new URL('../../../scripts/v5-user-contract-smoke.mjs', import.meta.url)),
        models: undefined,
      }
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const child = spawn(
        process.execPath,
        [runner.entry],
        {
          env: {
            ...process.env,
            V5_E2E_BASE: `http://127.0.0.1:${server.address().port}`,
            V5_CANARY_PASSWORD_FILE: join(dir, 'password'),
            V5_CONTRACT_COST: cost,
            V5_SELFHOST_MODEL_POLICY_FILE: join(dir, 'model-availability.json'),
            V5_CONTRACT_MODEL_ID: 'gpt-6-luna',
            V5_CONTRACT_MODELS: runner.models,
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
        cost === 'dry' ? [] : [
          artifact === true ? 'grok-build' : 'gpt-6-luna',
          artifact === true ? 'grok-build' : 'gpt-6-luna',
          'deepseek-v4-flash', 'deepseek-v4-flash',
        ],
      )
      if (cost === 'live') {
        // Each model's two turns share one session; the two models use different sessions.
        assert.equal(calls[0].peer.id, calls[1].peer.id)
        assert.equal(calls[2].peer.id, calls[3].peer.id)
        assert.notEqual(calls[0].peer.id, calls[2].peer.id)
        assert.equal((output.match(/# continuation model=\S+ turns=2 same_session=ok recall=ok/g) ?? []).length, 2, output)
        // The fake backend plants only on the neutral order-number wording; a reverted
        // "暗号" prompt would never be planted and the recall above would go red.
        assert.ok(
          calls.some((f) => /编号是 PO-[A-Z]{4}[0-9]{4}/.test(f.content.text)),
          'INC-20261014-SELFHOST-C3-GROK-REFUSAL: turn 1 registers a PO-<code> order number and turn 2 recalls it',
        )
      }
      console.log(`# synthetic-grok=${artifact}-${cost} ${output.match(/# timings_ms .*/)?.[0]}`)
    } finally {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    }
  })
