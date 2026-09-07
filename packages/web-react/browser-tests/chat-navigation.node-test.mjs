import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { build as viteBuild } from 'vite';
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const here = dirname(fileURLToPath(import.meta.url));

test('Chat navigation: real components, production CSS, trusted pointer/touch', { timeout: 300000 }, async t => {
  const out = mkdtempSync(join(tmpdir(), 'oc-chat-navigation-'));
  const bundle = await build({ entryPoints: [join(here, 'mobile-harness.tsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css':'empty' }, alias: { 'node:crypto':join(here,'stubs/node-crypto.js') }, define: { 'process.env.NODE_ENV':'"production"', 'import.meta.env.MODE':'"production"' }, logLevel:'silent', plugins:process.env.OC_CHAT_BASELINE ? [{name:'red-baseline',setup(b){b.onLoad({filter:/src\/components\/(ChatHeader|ModelSelector|MessageRenderer|chat\/stickToBottom)\.tsx?$/},args=>({contents:execFileSync('git',['show',`${process.env.OC_CHAT_BASELINE}:${args.path.slice(args.path.indexOf('packages/web-react/'))}`],{cwd:join(here,'../../..'),encoding:'utf8'}),loader:args.path.endsWith('.tsx')?'tsx':'ts'}));}}] : [] });
  await viteBuild({ root: join(here,'..'), configFile:false, logLevel:'silent', plugins:[tailwindcss()], build:{ outDir:out, emptyOutDir:true, cssCodeSplit:false, rollupOptions:{input:join(here,'preview-styles.ts'),output:{assetFileNames:'styles[extname]'}}} });
  const css=readFileSync(join(out,readdirSync(out).find(n=>n.endsWith('.css'))),'utf8');
  const browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:['--no-sandbox']});
  try {
    async function scenario(name, width, touch, run) {
      await t.test(name, async()=>{
        const context=await browser.newContext({viewport:{width,height:844},isMobile:touch,hasTouch:touch});
        try {
          const page=await context.newPage(); page.setDefaultTimeout(4000);
          const errors=[]; page.on('pageerror',e=>errors.push(e.message));
          await page.setContent('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+css+'</style><div id="root"></div>');
          await page.addScriptTag({content:bundle.outputFiles[0].text});
          await page.getByTestId('mobile-chat-scroll').waitFor();
          if (!name.startsWith("header")) await page.evaluate(()=>{window.__mobilePage.growTimeline(); window.__mobilePage.growTimeline();});
          await page.waitForTimeout(200);
          await page.evaluate(()=>window.__mobilePage.armSticky());
          await page.waitForTimeout(250);
          await run(page);
          assert.deepEqual(errors,[]);
        } finally { await context.close(); }
      });
    }
    const distance=page=>page.getByTestId('mobile-chat-scroll').evaluate(e=>e.scrollHeight-e.clientHeight-e.scrollTop);
    const leave=async(page,px=300)=>{
      await page.getByTestId('mobile-chat-scroll').hover();
      await page.mouse.wheel(0,-px); await page.waitForTimeout(280);
    };
    const atBottom=async page=>page.waitForFunction(()=>{const e=document.querySelector('[data-testid="mobile-chat-scroll"]');return e.scrollHeight-e.clientHeight-e.scrollTop<2;});
    for (const touch of [false,true]) await scenario(touch?'one tap resumes following despite touch-release fence':'one click resumes following after upward wheel',390,touch,async page=>{
      await leave(page); assert.ok(await distance(page)>100);
      const height=await page.getByTestId('mobile-chat-scroll').evaluate(e=>e.scrollHeight);
      assert.equal((await page.getByTestId('scroll-to-bottom-dock').boundingBox()).height,0);
      const btn=page.getByTestId('scroll-to-bottom');
      if(touch) await btn.tap(); else await btn.click();
      await atBottom(page);
      assert.equal(await page.getByTestId('mobile-chat-scroll').evaluate(e=>e.scrollHeight),height,'button toggling must not change scroll geometry');
      await page.evaluate(()=>window.__mobilePage.growTimeline()); await atBottom(page);
      await page.waitForTimeout(250); assert.ok(await distance(page)<2);
      assert.equal(await page.getByTestId('scroll-to-bottom-dock').getAttribute('data-visible'),'false');
      await leave(page); assert.ok(await distance(page)>100,'new upward gesture still wins');
      if(!touch){ await btn.focus(); await page.keyboard.press('Enter'); await atBottom(page); }
    });
    await scenario('near-bottom tiny upward movement does not flash the button',390,true,async page=>{
      await leave(page,8); assert.ok(await distance(page)<80);
      assert.equal(await page.getByTestId('scroll-to-bottom-dock').getAttribute('data-visible'),'false');
    });
    for (const width of [320,375,390,768,1280]) await scenario(`header ${width}px: controls separated and tappable`,width,true,async page=>{
      const agent=page.locator('header button[data-product-feature="agents"]');
      const model=page.getByRole('button',{name:'选择对话模型'});
      const controls=page.locator('header button');
      const rects=await controls.evaluateAll(es=>es.map(e=>({label:e.getAttribute('aria-label')||e.textContent,...(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};})()})).filter(r=>r.w>0&&r.h>0));
      for(const r of rects){assert.ok(r.x>=-1&&r.right<=width+1,JSON.stringify(r));assert.ok(r.h>=43.5,`small target ${JSON.stringify(r)}`);}
      for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
        const a=rects[i],b=rects[j]; assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,`overlap ${a.label}/${b.label}`);
      }
      const box=await model.boundingBox();const nav=rects.find(r=>r.label?.includes('打开菜单'));
      if(width<640) assert.ok(box.y>=nav.bottom-1,'model has its own mobile row');
      await model.tap(); await page.getByRole('menu').waitFor();
      await page.getByRole('menuitem',{name:/OpenClaude 均衡 Pro/}).tap();
      assert.match(await model.textContent(),/均衡 Pro/);
      if(width===390&&process.env.OC_CHAT_SHOT) await page.screenshot({path:process.env.OC_CHAT_SHOT});
    });
  } finally {await browser.close();}
});
