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
const root = process.env.OCV5_IDENTITY_UI_ROOT || repo;
const profile = { profileId: 'selfhost-butler', legacyAgentId: 'butler', canonicalAgentId: 'personal-butler', localPersonaPath: 'agents/butler/CLAUDE.md', localSkillStorageId: 'butler' };

test('registered canonical management edits only the actual local manual, not marketplace persona', { timeout: 90000 }, async () => {
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {TooltipProvider} from ${JSON.stringify(resolve(root, 'packages/web-react/src/components/ui/Tooltip.tsx'))};
    import {ToastProvider} from ${JSON.stringify(resolve(root, 'packages/web-react/src/components/ui/Toast.tsx'))};
    import {MemoryPanel} from ${JSON.stringify(resolve(root, 'packages/web-react/src/components/manage/MemoryPanel.tsx'))};
    import {createMemoryAuthSession} from ${JSON.stringify(resolve(root, 'packages/web-react/src/lib/authSession.ts'))};
    const auth=createMemoryAuthSession(()=>{},'fixture-token');
    createRoot(document.getElementById('root')).render(<TooltipProvider><ToastProvider><MemoryPanel auth={auth} agentId={location.search.includes('unavailable')?'main':'personal-butler'} agents={location.search.includes('unavailable')?[{id:'main',name:'全能助手'}]:[{id:'personal-butler',name:'个人管家'}]}/></ToastProvider></TooltipProvider>);
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: repo, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, nodePaths: [resolve(repo, 'node_modules')], alias: { '@openclaude/protocol/containerPreview': resolve(repo, 'packages/protocol/src/containerPreview.ts'), 'node:crypto': resolve(here, 'stubs/node-crypto.js'), '@openclaude/protocol': resolve(repo, 'packages/protocol/src/index.ts') }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' } });
  let local = '本地手册原文\n保留旧运行规则';
  const market = '市场底线：禁止自动批准';
  let registered = true, failSave = 0, unavailable = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = req.url;
    if (url.startsWith('/?') || url === '/') return res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>');
    res.setHeader('content-type', 'application/json');
    const send = (body, status = 200) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url, method: req.method, raw, auth: req.headers.authorization });
    if (url === '/api/auth/refresh') return send({error:{code:'INVALID_REFRESH',message:'登录已过期'}},401);
    if (url === '/api/agents') return send({ agents: [{id:'butler'}, {id:'personal-butler'}], default: 'main', ...(registered ? {identityCompat: {schema:1,userId:'3',profiles:[{profile,readiness:unavailable?'unavailable':'ready'}]}} : {}) });
    if (url === '/api/agents/butler/persona') {
      if (req.method === 'PUT') { if (failSave) return send({error:'保存被拒绝'}, failSave); local = JSON.parse(raw).text; return send({ok:true,path:'/fixture/agents/butler/CLAUDE.md'}); }
      return send({text:local,path:'/fixture/agents/butler/CLAUDE.md'});
    }
    if (url === '/api/agents/personal-butler/persona') return send({text:market,path:'/fixture/agents/personal-butler/CLAUDE.md'});
    if (url.endsWith('/memory/memory')) return send({kind:'index',text:'',files:[],version:'v1'});
    if (url.endsWith('/auto-dream-report')) return send({status:'idle',pendingSessions:0});
    if (url.endsWith('/auto-dream-optimizer')) return send({status:'idle',enabled:false});
    return send({error:'fixture not found'},404);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  let browser;
  try {
    browser = await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:['--no-sandbox']});
    const page = await browser.newPage({ viewport: {width:390,height:844} }); page.setDefaultTimeout(7000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    async function open(query='') { await page.goto(`http://127.0.0.1:${server.address().port}/${query}`); await page.addScriptTag({content:bundle.outputFiles[0].text}); await page.getByText('还没有核心记忆').waitFor(); }
    await open();
    await page.getByRole('button',{name:'本实例运行手册',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'本地运行手册正文'});
    await editor.waitFor();
    assert.equal(await editor.inputValue(),local);
    assert.equal(await page.getByLabel('市场底线（只读）').textContent(),market);
    assert.equal(await page.getByRole('textbox').count(),1);
    const next='修改后的本地运行手册\n中文与换行均须保存';
    await editor.fill(next);
    await page.getByRole('button',{name:'保存本地手册',exact:true}).click();
    await page.getByText('本地手册已保存并核对').waitFor();
    assert.equal(local,next);
    const writes=requests.filter(r=>r.method==='PUT');
    assert.equal(writes.length,1); assert.equal(writes[0].url,'/api/agents/butler/persona'); assert.deepEqual(JSON.parse(writes[0].raw),{text:next}); assert.equal(writes[0].auth,'Bearer fixture-token');
    assert.ok(requests.filter(r=>r.url==='/api/agents/butler/persona'&&r.method==='GET').length>=2);
    await page.getByRole('button',{name:'本实例运行手册',exact:true}).click();
    await page.getByRole('button',{name:'本实例运行手册',exact:true}).click();
    await editor.waitFor(); assert.equal(await editor.inputValue(),next);
    assert.equal(await page.getByLabel('市场底线（只读）').textContent(),market);
    if(process.env.OCV5_IDENTITY_UI_SCREENSHOT) await page.screenshot({path:process.env.OCV5_IDENTITY_UI_SCREENSHOT,fullPage:true});
    for (const status of [409,500]) {
      failSave=status; await editor.fill('不能保存'+status); await page.getByRole('button',{name:'保存本地手册',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'保存被拒绝'}).waitFor(); assert.equal(local,next);
      await page.getByRole('button',{name:'本实例运行手册',exact:true}).click();
      await page.getByRole('button',{name:'本实例运行手册',exact:true}).click(); await editor.waitFor();
    }
    unavailable=true; failSave=0; await open('?unavailable');
    await page.getByRole('combobox',{name:'选择智能体'}).selectOption('personal-butler');
    await page.getByRole('button',{name:'本实例运行手册',exact:true}).click(); await editor.waitFor();
    await page.getByText(/智能体当前不可执行/).waitFor();
    await editor.fill('卸载后仍可到达并编辑本地手册'); await page.getByRole('button',{name:'保存本地手册',exact:true}).click();
    await page.getByText('本地手册已保存并核对').waitFor(); assert.equal(local,'卸载后仍可到达并编辑本地手册');
    await open('?unavailable'); await page.getByRole('combobox',{name:'选择智能体'}).selectOption('personal-butler');
    await page.getByRole('button',{name:'本实例运行手册',exact:true}).click(); await editor.waitFor();
    const before401=local; failSave=401; await editor.fill('未登录不能保存'); await page.getByRole('button',{name:'保存本地手册',exact:true}).click();
    await editor.waitFor({state:'detached'}); assert.equal(local,before401);
    assert.equal(await page.getByText('本地手册已保存并核对').count(),0);
    registered=false; const before=requests.length; await open();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="identity-manual-loading"]'));
    assert.equal(await page.getByRole('button',{name:'本实例运行手册',exact:true}).count(),0);
    assert.equal(requests.slice(before).filter(r=>r.url.endsWith('/persona')).length,0);
    assert.equal(requests.filter(r=>r.url==='/api/agents/personal-butler/persona'&&r.method==='PUT').length,0);
    assert.deepEqual(errors,[]);
  } finally {if(browser) await browser.close(); await new Promise(done=>server.close(done));}
});
