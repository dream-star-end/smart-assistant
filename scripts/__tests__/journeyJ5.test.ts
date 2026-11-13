import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-ignore -- plain ESM helper without types
import { launchJourneyBrowser } from '../lib/journey-browser.mjs'
// @ts-ignore -- plain ESM helper without types
import { waitJ5Delivered } from '../lib/journey-j5.mjs'

// 2026-10-08 smoke robustness: J5 anchored on our own user row; backend-proven bounded grace.
const MARKER = 'e2e journey canary abc123'
const PROBE = 'OC_ATTACH_abc123_secret'
const userRow = (t: string) => `<div data-testid="user-row"><div data-testid="message-text">${t}</div></div>`
const asst = (body: string, extra = '') => `<div data-testid="assistant-row"><div class="prose">${body}</div>${extra}</div>`
const SEND = '<button aria-label="发送">发送</button>'
const STOP = '<button aria-label="停止">停止</button>'

// `steps`: [ms, html] — the chat body is replaced at each time offset.
function page(steps: Array<[number, string]>, sidebar = '') {
  const js = steps.map(([ms, html]) => `setTimeout(()=>{document.getElementById('chat').innerHTML=${JSON.stringify(html)}},${ms});`).join('')
  return `<!doctype html><nav>${sidebar}</nav><main id="chat"></main><script>${js}</script>`
}

async function run(html: string, opts: Record<string, unknown> = {}) {
  const browser = await launchJourneyBrowser()
  const logs: string[] = []
  let evidence: unknown = null
  try {
    const p = await browser.newPage()
    await p.setContent(html)
    const started = Date.now()
    try {
      const r = await waitJ5Delivered(p, {
        marker: MARKER, probeToken: PROBE, turnWaitMs: 800, graceMs: 1_500, pollMs: 50,
        backendCheck: () => ({ checked: true, found: false, detail: 'n=0' }),
        log: (l: string) => logs.push(l), onEvidence: (e: unknown) => { evidence = e },
        ...opts,
      })
      return { ok: true as const, r, logs, evidence, ms: Date.now() - started }
    } catch (err) {
      return { ok: false as const, err: err as Error, logs, evidence, ms: Date.now() - started }
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

const goal = userRow('e2e-goal-x') + asst('我先读取完整请求', '<span>已停止生成</span>')

test('OCV5-334: a stopped goal row before our message and a shifting row count do not hide the reply', { timeout: 60_000 }, async () => {
  const r = await run(page([
    [0, goal + asst('placeholder') + userRow(MARKER) + STOP],
    // the goal turn's extra row disappears (count drops) while our reply streams, then finishes
    [200, goal + userRow(MARKER) + asst('OC_ATTACH', '<span class="caret-blink"></span>') + STOP],
    [400, goal + userRow(MARKER) + asst(PROBE) + SEND],
  ]))
  assert.equal(r.ok, true, r.ok ? '' : r.err.message)
  assert.deepEqual(r.logs, [])
})

test('only rows AFTER our user row count: an earlier finished row with the probe is not accepted', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, asst(PROBE) + userRow(MARKER) + SEND]]))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /180|0\.8s 内未完成.*后端核对:n=0/)
})

test('marker only in the sidebar (no chat user row) never anchors', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, goal + asst(PROBE) + SEND]], `<a>${MARKER}</a>`))
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /内未完成/)
})

test('no backend proof at the deadline -> fails immediately, no grace', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, userRow(MARKER) + asst('...', '<span class="caret-blink"></span>') + STOP]]), { graceMs: 30_000 })
  assert.equal(r.ok, false)
  assert.ok(r.ms < 10_000, `took ${r.ms}ms`)
  assert.deepEqual((r.evidence as any)?.backend, { checked: true, found: false, detail: 'n=0' })
})

test('backend has the probe reply and the UI settles in the grace window -> pass, recorded as slow_ui_settle', { timeout: 60_000 }, async () => {
  const r = await run(page([
    [0, userRow(MARKER) + asst('OC_ATTACH', '<span class="caret-blink"></span>') + STOP],
    [1_400, userRow(MARKER) + asst(PROBE) + SEND],
  ]), { backendCheck: () => ({ checked: true, found: true, detail: 'n=1' }) })
  assert.equal(r.ok, true, r.ok ? '' : r.err.message)
  assert.match(r.logs.join('\n'), /warn slow_ui_settle J5 ui_settled_ms_after_backend=\d+/)
})

test('backend has the probe reply but the UI never settles -> hard fail after the grace with evidence', { timeout: 60_000 }, async () => {
  const r = await run(page([[0, userRow(MARKER) + asst(PROBE, '<span class="caret-blink"></span>') + STOP]]),
    { backendCheck: () => ({ checked: true, found: true, detail: 'n=1' }) })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.err.message, /UI 在宽限 1\.5s 内仍未收尾/)
  assert.ok((r.evidence as any).atDeadline && (r.evidence as any).atGraceEnd)
})

test('zero tolerance stays: failure signature, alert row and missing probe all fail', { timeout: 60_000 }, async () => {
  const sig = await run(page([[0, `${userRow(MARKER)}<div>发送失败</div>${SEND}`]]))
  assert.match(sig.ok ? '' : sig.err.message, /发送失败签名出现/)
  const alert = await run(page([[0, userRow(MARKER) + asst(PROBE, '<div role="alert">x</div>') + SEND]]))
  assert.match(alert.ok ? '' : alert.err.message, /错误\/空轮\/截断/)
  const noProbe = await run(page([[0, userRow(MARKER) + asst('我猜是 hello') + SEND]]))
  assert.match(noProbe.ok ? '' : noProbe.err.message, /未包含附件秘密探针/)
})


// Actual browser clicks, dialogs and chat rows; no mocked Playwright calls.
test('OCV5-763: J4 cost confirmation is bounded and anchored to the sent user row', { timeout: 120_000 }, async (t) => {
  const { selectJourneyModel, waitJourneyUserRow } = await import('../lib/journey-browser.mjs')
  const browser = await launchJourneyBrowser()
  try {
    const cases = [
      { mode: 'risk', ok: true, clicks: 1 },
      { mode: 'estimate', ok: true, clicks: 1 },
      { mode: 'delayed', ok: true, clicks: 1 },
      { mode: 'no-dialog', ok: true, clicks: 0 },
      { mode: 'wrong-target', ok: false, clicks: 0 },
      { mode: 'prefix-target', ok: false, clicks: 0 },
      { mode: 'source-only', ok: false, clicks: 0 },
      { mode: 'disabled', ok: false, clicks: 0 },
      { mode: 'unrelated', ok: false, clicks: 0 },
      { mode: 'multiple', ok: false, clicks: 0 },
      { mode: 'repeated', ok: false, clicks: 1 },
      { mode: 'no-row-after-confirm', ok: false, clicks: 1 },
      { mode: 'sidebar-only', ok: false, clicks: 0 },
      { mode: 'optimistic-row-with-wrong-dialog', ok: false, clicks: 0 },
    ]
    for (const c of cases) await t.test(c.mode, async () => {
      const p = await browser.newPage()
      try {
        await p.setContent(`<!doctype html><button aria-label="选择对话模型">默认</button>
          <div role="menu" hidden><button data-model-id="grok-build"><span class="truncate">Grok 4.7</span><span>0.5× 限时优惠</span></button></div>
          <aside>${MARKER}</aside><main id="chat"></main><button id="send" aria-label="发送">发送</button>
          <script>
          const mode=${JSON.stringify(c.mode)}, marker=${JSON.stringify(MARKER)};
          window.confirmClicks=0;
          const menu=document.querySelector('[role=menu]');
          document.querySelector('[aria-label="选择对话模型"]').onclick=()=>menu.hidden=false;
          document.querySelector('[data-model-id]').onclick=()=>{menu.hidden=true;document.querySelector('[aria-label="选择对话模型"]').textContent='Grok 4.7';};
          const row=()=>document.querySelector('#chat').innerHTML='<div data-testid="user-row">'+marker+'</div>';
          function modal() {
            const d=document.createElement('section');d.setAttribute('role','dialog');
            d.setAttribute('aria-label',mode==='unrelated'?'删除会话？':'切换模型？');
            const target=['wrong-target','source-only','optimistic-row-with-wrong-dialog'].includes(mode)?'DeepSeek V4':mode==='prefix-target'?'Grok 4.7 Pro':'Grok 4.7';
            const summary=mode==='estimate'||mode==='source-only'
              ?'<p>目标模型：'+target+' · 当前上下文约 500 tokens</p><p>继续使用 Grok 4.7 约 1 积分。</p>'
              :'<p>无法预估本轮费用</p><p>当前输入或重建上下文缺少可靠计数，切换后第一轮可能明显更贵。确认后将使用 '+target+' 。</p>';
            d.innerHTML='<h2>'+d.getAttribute('aria-label')+'</h2><div data-testid="model-switch-cost-summary">'+summary+'</div><button>取消</button><button data-confirm '+(mode==='disabled'?'disabled':'')+'>确认切换</button>';
            d.querySelector('[data-confirm]').onclick=()=>{window.confirmClicks++;d.remove();
              if(mode==='repeated')setTimeout(modal,60);
              else if(mode!=='no-row-after-confirm')row();};
            document.body.append(d);
          }
          document.querySelector('#send').onclick=()=>{
            if(mode==='no-dialog'){row();return;}if(mode==='sidebar-only')return;
            if(mode==='optimistic-row-with-wrong-dialog')row();
            if(mode==='delayed')setTimeout(modal,100);else modal();
            if(mode==='multiple')modal();
          };
          </script>`)
        const label = await selectJourneyModel(p, 'grok-build', { timeout: 3_000 })
        assert.equal(label, 'Grok 4.7', 'cost multiplier and promotion are not the display name')
        await p.getByRole('button', { name: '发送', exact: true }).click()
        let result: { confirmed: boolean } | undefined
        let error: unknown
        try { result = await waitJourneyUserRow(p, { marker: MARKER, modelLabel: label, timeout: 1_000 }) }
        catch (e) { error = e }
        assert.equal(!error, c.ok, String(error))
        assert.equal(await p.evaluate(() => (window as any).confirmClicks), c.clicks)
        if (c.ok) {
          assert.equal(result?.confirmed, c.clicks === 1)
          assert.equal(await p.getByTestId('user-row').filter({ hasText: MARKER }).count(), 1)
          assert.equal(await p.getByRole('dialog').count(), 0)
        } else {
          assert.equal(result, undefined)
          if (c.mode !== 'optimistic-row-with-wrong-dialog') assert.equal(await p.getByTestId('user-row').count(), 0)
        }
      } finally { await p.close() }
    })
  } finally { await browser.close() }
})


// Real DOM events reproduce the queue that the old J3 left in front of J4.
test('OCV5-763: J3 stops only its anchored goal and reaches a sendable composer', { timeout: 60_000 }, async (t) => {
  const { settleJourneyGoalTurn, waitJourneyUserRow } = await import('../lib/journey-browser.mjs')
  const browser = await launchJourneyBrowser()
  const goalMarker = 'e2e-goal-owned'
  function fixture(mode: string) {
    return `<!doctype html><aside>${goalMarker}</aside><main id="chat">${['missing-row', 'sidebar-only'].includes(mode) ? '' : userRow(goalMarker)}</main>
      <section data-testid="composer-shell"><div id="controls"></div></section><button id="j4">Send J4</button>
      <script>
      const mode=${JSON.stringify(mode)}, marker=${JSON.stringify(MARKER)};
      window.stopClicks=0;window.busy=mode!=='natural';
      function controls(label, disabled=false) {
        document.querySelector('#controls').innerHTML='<button data-product-control aria-label="'+label+'" '+(disabled?'disabled':'')+'>'+label+'</button>';
        document.querySelector('#controls button').onclick=()=>{
          window.stopClicks++;
          if(mode==='stuck')return;
          controls('正在停止',true);
          setTimeout(()=>{window.busy=false;controls('发送');},150);
        };
      }
      if(mode==='natural')controls('发送');
      else if(mode==='initial-stopping'){
        controls('正在停止',true);setTimeout(()=>{window.busy=false;controls('发送');},150);
      } else controls('停止');
      if(mode==='disabled-send'){window.busy=false;controls('发送',true);}
      if(mode==='duplicate-stop')document.querySelector('#controls').insertAdjacentHTML('beforeend','<button data-product-control aria-label="停止">停止</button>');
      if(mode==='queued')document.body.insertAdjacentHTML('beforeend','<div data-testid="queued-send-row">queued</div>');
      if(mode==='dialog')document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-label="unrelated">dialog</div>');
      document.querySelector('#j4').onclick=()=>{
        if(window.busy)document.body.insertAdjacentHTML('beforeend','<div data-testid="queued-send-row">'+marker+'</div>');
        else document.querySelector('#chat').insertAdjacentHTML('beforeend','<div data-testid="user-row">'+marker+'</div>');
      };
      </script>`
  }
  try {
    for (const mode of ['active', 'natural', 'initial-stopping', 'stuck', 'missing-row', 'sidebar-only', 'queued', 'duplicate-stop', 'dialog', 'disabled-send']) await t.test(mode, async () => {
      const p = await browser.newPage()
      try {
        await p.setContent(fixture(mode))
        const started = Date.now()
        let result: { stopped: boolean } | undefined
        let error: unknown
        try { result = await settleJourneyGoalTurn(p, { goalMarker, timeout: 600 }) } catch (e) { error = e }
        const ok = ['active', 'natural', 'initial-stopping'].includes(mode)
        assert.equal(!error, ok, String(error))
        const clicks = await p.evaluate(() => (window as any).stopClicks)
        assert.equal(clicks, ['active', 'stuck'].includes(mode) ? 1 : 0)
        assert.ok(Date.now() - started < 3_000, 'no separate default Playwright timeout')
        if (ok) {
          assert.equal(result?.stopped, mode === 'active')
          assert.equal(await p.evaluate(() => (window as any).busy), false)
          await p.locator('#j4').click()
          await waitJourneyUserRow(p, { marker: MARKER, modelLabel: 'Grok 4.7', timeout: 600 })
          assert.equal(await p.getByTestId('queued-send-row').count(), 0)
        } else {
          assert.equal(result, undefined)
          assert.match(String(error), /J3 goal turn|queued messages|Ambiguous journey composer control|Unexpected journey goal dialog/)
        }
      } finally { await p.close() }
    })
    await t.test('red control: old J3 without Stop queues J4 and cannot prove admission', async () => {
      const p = await browser.newPage()
      try {
        await p.setContent(fixture('active'))
        await p.locator('#j4').click()
        assert.equal(await p.getByTestId('queued-send-row').count(), 1)
        await assert.rejects(waitJourneyUserRow(p, { marker: MARKER, modelLabel: 'Grok 4.7', timeout: 600 }), /J4 user-row did not arrive/)
        assert.equal(await p.evaluate(() => (window as any).stopClicks), 0)
        assert.equal(await p.getByTestId('user-row').filter({ hasText: MARKER }).count(), 0)
      } finally { await p.close() }
    })
  } finally { await browser.close() }
})


// Fix the exact browser-task interleaving without fabricating any DOM results.
test('OCV5-763: J3 natural finish during control sampling keeps the shared deadline', { timeout: 20_000 }, async (t) => {
  const { settleJourneyGoalTurn } = await import('../lib/journey-browser.mjs')
  const browser = await launchJourneyBrowser()
  try {
    for (const mode of ['finish', 'disappear']) await t.test(mode, async () => {
      const p = await browser.newPage()
      p.setDefaultTimeout(5_000)
      try {
        await p.setContent(`${userRow('goal-race')}<section data-testid="composer-shell"><button data-product-control aria-label="停止">停止</button></section><script>window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;</script>`)
        const evaluate = p.evaluate.bind(p)
        let interleaved = false
        p.evaluate = async (...args: any[]) => {
          const result = await (evaluate as any)(...args)
          if (!interleaved && result?.label === '停止') {
            interleaved = true
            await evaluate((action) => {
              const button = document.querySelector('button')!
              if (action === 'finish') button.setAttribute('aria-label', '发送')
              else button.remove()
            }, mode)
          }
          return result
        }
        const started = Date.now()
        if (mode === 'finish') {
          assert.deepEqual(await settleJourneyGoalTurn(p, { goalMarker: 'goal-race', timeout: 1_000 }), { stopped: false })
          assert.equal(await evaluate(() => (window as any).clicks), 0)
        } else {
          await assert.rejects(settleJourneyGoalTurn(p, { goalMarker: 'goal-race', timeout: 1_000 }), /Ambiguous journey composer control/)
        }
        assert.equal(interleaved, true, 'must hit the actual snapshot→action interleaving')
        assert.ok(Date.now() - started < 1_200, 'must not use the 5s page default waiting for an obsolete button')
      } finally { await p.close() }
    })
  } finally { await browser.close() }
})


test('OCV5-763: J3 trial actionability never retries an uncertain real Stop', { timeout: 60_000 }, async (t) => {
  const { settleJourneyGoalTurn, waitJourneyUserRow } = await import('../lib/journey-browser.mjs')
  const browser = await launchJourneyBrowser()
  try {
    for (const mode of ['moving', 'overlay', 'permanent-overlay', 'post-click-timeout', 'after-trial-blocked', 'after-trial-finish']) await t.test(mode, async () => {
      const p = await browser.newPage()
      let realCalls = 0
      try {
        await p.setContent(`${userRow('goal-actionable')}<section data-testid="composer-shell"><button data-product-control aria-label="停止">Stop</button></section><button id="j4">J4</button>
          <style>@keyframes move {from{transform:translateX(0)}to{transform:translateX(160px)}}button.moving{animation:move 900ms linear}</style>
          <script>
          window.clicks=0;window.busy=true;
          const b=document.querySelector('[data-product-control]');
          b.onclick=()=>{window.clicks++;b.setAttribute('aria-label','正在停止');b.disabled=true;setTimeout(()=>{window.busy=false;b.disabled=false;b.setAttribute('aria-label','发送')},75)};
          window.cover=()=>{const d=document.createElement('div');d.id='cover';d.style='position:fixed;inset:0;z-index:9999;background:transparent';document.body.append(d);return d};
          const mode=${JSON.stringify(mode)};
          if(mode==='moving')b.className='moving';
          if(mode==='overlay'||mode==='permanent-overlay'){const d=window.cover();if(mode==='overlay')setTimeout(()=>d.remove(),900)}
          document.querySelector('#j4').onclick=()=>document.body.insertAdjacentHTML('beforeend',window.busy?'<div data-testid="queued-send-row">actionable-j4</div>':'<div data-testid="user-row">actionable-j4</div>');
          </script>`)
        const getByTestId = p.getByTestId.bind(p)
        let interleaved = false
        p.getByTestId = ((id: string) => {
          const scope = getByTestId(id)
          if (id !== 'composer-shell') return scope
          const locate = scope.locator.bind(scope)
          scope.locator = ((selector: string) => {
            const control = locate(selector)
            const click = control.click.bind(control)
            control.click = async (options: any) => {
              if (!options?.trial) realCalls++
              await click(options)
              if (options?.trial && !interleaved && mode.startsWith('after-trial-')) {
                interleaved = true
                await p.evaluate((action) => {
                  const b = document.querySelector('[data-product-control]')!
                  if (action === 'after-trial-finish') {
                    ;(window as any).busy = false
                    b.setAttribute('aria-label', '发送')
                  }
                }, mode)
                if (mode === 'after-trial-blocked') await p.evaluate(() => {
                  const cover = (window as any).cover()
                  setTimeout(() => cover.remove(), 900)
                })
              }
              if (!options?.trial && mode === 'post-click-timeout') {
                const error = new Error('reported timeout after real DOM click')
                error.name = 'TimeoutError'
                throw error
              }
            }
            return control
          }) as typeof scope.locator
          return scope
        }) as typeof p.getByTestId
        const started = Date.now()
        const ok = !['permanent-overlay', 'after-trial-blocked'].includes(mode)
        let result: { stopped: boolean } | undefined
        let error: unknown
        try { result = await settleJourneyGoalTurn(p, { goalMarker: 'goal-actionable', timeout: 1_800 }) } catch (e) { error = e }
        assert.equal(!error, ok, String(error))
        assert.ok(Date.now() - started < 3_200, 'same deadline, no default Playwright timeout')
        const delivered = ['moving', 'overlay', 'post-click-timeout'].includes(mode)
        assert.equal(await p.evaluate(() => (window as any).clicks), delivered ? 1 : 0)
        assert.equal(realCalls, delivered || mode === 'after-trial-blocked' ? 1 : 0)
        if (ok) {
          assert.ok(result)
          assert.equal(await p.evaluate(() => (window as any).busy), false)
          await p.locator('#j4').click()
          await waitJourneyUserRow(p, { marker: 'actionable-j4', modelLabel: 'Grok 4.7', timeout: 600 })
          assert.equal(await p.getByTestId('queued-send-row').count(), 0)
        } else {
          assert.equal(result, undefined)
          assert.match(String(error), /J3 goal turn did not become sendable/)
        }
      } finally { await p.close() }
    })
  } finally { await browser.close() }
})
