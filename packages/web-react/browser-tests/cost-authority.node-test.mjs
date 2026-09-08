import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
// Red/green uses the identical browser scenario against actual old/new components.
const sourceRoot = process.env.OCV5_COST_COMPONENT_ROOT || repo;

test('recorded-cost provenance remains visible in totals, legacy responses and run details', { timeout: 90000 }, async () => {
  const source = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {TooltipProvider} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/components/ui/Tooltip.tsx'))};
    import {ToastProvider} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/components/ui/Toast.tsx'))};
    import {BoardSettingsPanel} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/components/taskboard/BoardSettingsPanel.tsx'))};
    import {taskboardApi} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/lib/taskboard.ts'))};
    import {CostCoverageBlock} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/components/taskboard/CostCoverageBlock.tsx'))};
    import {TicketTimeline} from ${JSON.stringify(resolve(sourceRoot, 'packages/web-react/src/components/taskboard/TicketTimeline.tsx'))};
    const empty={runCount:0,tokensIn:0,tokensOut:0,costUsd:0};
    const slice=n=>({runCount:1,tokensIn:100,tokensOut:10,costUsd:n});
    const mixed={runCount:3,tokensIn:300,tokensOut:30,costUsd:6,coverage:'full',priced:{runCount:3,tokensIn:300,tokensOut:30,costUsd:6},unpriced:empty,unknownRunCount:0,amounts:{estimated:slice(1),unflagged:slice(2),unverified:slice(3)}};
    const cases={mixed,legacy:{...mixed,amounts:undefined},unpriced:{...mixed,coverage:'unpriced_only',costUsd:0,priced:empty,unpriced:slice(0),amounts:{estimated:empty,unflagged:empty,unverified:empty}},unknown:{...mixed,coverage:'none',costUsd:0,priced:empty,unknownRunCount:3,amounts:undefined}};
    cases.legacy_unknown={...cases.unknown,coverage:'full'};
    taskboardApi.getSettings=async()=>({maxConcurrentRuns:2,maxRunsPerDay:200,maxCostPerDayUsd:null,quietHoursStart:23,quietHoursEnd:8,circuitBreakerThreshold:3,maxStageLoops:5,maxRunsPerTick:2,patrolPaused:false,usage:{runsToday:1,costTodayUsd:0,activeRuns:0,unpricedRunsToday:1}});
    const auth={};
    const items=[true,false,null].map((flag,i)=>({kind:'run',createdAt:Date.now(),run:{id:'r'+i,stageId:'s',status:'succeeded',trigger:'manual',createdAt:Date.now(),durationMs:100,tokensIn:100,tokensOut:10,costUsd:i+1,costImprecise:flag}}));
    function App(){const [mode,setMode]=useState('mixed');return <><nav data-current-mode={mode}>{Object.keys(cases).map(k=><button key={k} onClick={()=>setMode(k)}>{k}</button>)}</nav><CostCoverageBlock totals={cases[mode]}/><TicketTimeline items={items} loading={false} stageName='执行' stageById={new Map([['s','执行']])}/></>}
    createRoot(document.getElementById('root')).render(<ToastProvider><TooltipProvider><App/><BoardSettingsPanel auth={auth}/></TooltipProvider></ToastProvider>);
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: repo, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    nodePaths: [resolve(repo, 'node_modules')],
    alias: { '@openclaude/protocol/containerPreview': resolve(repo, 'packages/protocol/src/containerPreview.ts'), 'node:crypto': resolve(here, 'stubs/node-crypto.js'), '@openclaude/protocol': resolve(repo, 'packages/protocol/src/index.ts') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  });
  const server=createServer((_req,res)=>res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({ executablePath: resolveBrowserExecutable(), headless:true, args:['--no-sandbox'] });
    const page=await browser.newPage(); page.setDefaultTimeout(7000);
    const errors=[]; page.on('pageerror',e=>{errors.push(e.message); console.error('PAGEERROR',e.message)});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const money=page.getByTestId('cost-coverage-money');
    await money.waitFor();
    assert.match(await money.textContent(), /参考费用 \$6.0000/);
    assert.match(await money.textContent(), /估算 \$1.0000/);
    assert.match(await money.textContent(), /未标估算 \$2.0000/);
    assert.match(await money.textContent(), /来源未证实 \$3.0000/);
    await page.getByTestId('ticket-system-toggle').click();
    await page.getByTestId('ticket-run-detail').first().waitFor().catch(async e=>{console.error(await page.locator('body').innerText());throw e});
    const details=await page.getByTestId('ticket-run-detail').allTextContents();
    assert.equal(details.length,3);
    assert.ok(details.some(t=>t.includes('参考费用 $1.0000（估算）')));
    assert.ok(details.some(t=>t.includes('参考费用 $2.0000（未标估算）')));
    assert.ok(details.some(t=>t.includes('参考费用 $3.0000（来源未证实）')));
    await page.getByRole('button',{name:'legacy',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cost-coverage-money"]')?.textContent === '参考费用 $6.0000（来源未证实）');
    assert.match(await money.textContent(), /来源未证实/);
    await page.getByRole('button',{name:'unpriced',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cost-coverage-money"]')?.textContent?.includes('无单价'));
    assert.doesNotMatch(await money.textContent(), /\$0/);
    await page.getByRole('button',{name:'unknown',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="cost-coverage-money"]')?.textContent?.includes('未记录'));
    assert.match(await money.textContent(), /未记录/);
    assert.doesNotMatch(await money.textContent(), /\$0/);
    await page.getByRole('button',{name:'legacy_unknown',exact:true}).click();
    await page.waitForFunction(() => document.querySelector('nav')?.dataset.currentMode === 'legacy_unknown');
    await page.waitForFunction(() => document.querySelector('[data-testid="cost-coverage-money"]')?.textContent?.includes('未记录'));
    assert.doesNotMatch(await money.textContent(), /\$0/);
    await page.getByTestId('board-settings-open').click();
    const usageLine=page.getByText(/今天已跑/);
    await usageLine.waitFor();
    assert.match(await usageLine.textContent(), /1 次有用量但无金额/);
    assert.doesNotMatch(await usageLine.textContent(), /\$0/);
    assert.deepEqual(errors,[]);
    if(process.env.OCV5_COST_SCREENSHOT) await page.screenshot({path:process.env.OCV5_COST_SCREENSHOT,fullPage:true});
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});
