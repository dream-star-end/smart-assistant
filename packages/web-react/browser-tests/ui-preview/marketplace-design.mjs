// Real marketplace components + production CSS; only the API boundary uses fixtures.
// node browser-tests/ui-preview/marketplace-design.mjs [--serve]
import { build } from 'esbuild'
import { build as viteBuild } from 'vite'
import tailwind from '@tailwindcss/vite'
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import { resolveBrowserExecutable } from '../../../../scripts/lib/resolve-browser.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const pkg = dirname(dirname(here))
const out = process.env.OC_MARKET_EVIDENCE || await mkdtemp(join(tmpdir(), 'oc-marketplace-design-'))
await mkdir(out, { recursive:true })
const apiStub = join(here, 'api-stub.ts')
await build({
  entryPoints:[join(here,'harness.tsx')], bundle:true, format:'iife', outfile:join(out,'harness.js'), jsx:'automatic',
  loader:{'.css':'empty'}, define:{'process.env.NODE_ENV':'"production"','import.meta.env.MODE':'"production"','import.meta.env.PROD':'true','import.meta.env.DEV':'false'},
  alias:{'node:crypto':join(here,'../stubs/node-crypto.js')},
  plugins:[{name:'market-fixtures',setup(b) {
    b.onResolve({filter:/(^|\/)lib\/api$/}, a => a.importer===apiStub ? null : {path:apiStub})
    b.onResolve({filter:/\/scenes-manage$/}, () => ({path:'empty', namespace:'market-fixtures'}))
    b.onLoad({filter:/.*/,namespace:'market-fixtures'},()=>({contents:'export const scenes=[]'}))
  }}], logLevel:'warning',
})
await viteBuild({root:pkg,configFile:false,logLevel:'silent',plugins:[tailwind()],build:{outDir:join(out,'css'),emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:join(here,'../preview-styles.ts'),output:{assetFileNames:'assets/[name]-[hash][extname]'}}}})
const assets = await readdir(join(out,'css/assets'))
const cssName=assets.find(n=>n.endsWith('.css'))
assert(cssName)
const css=await readFile(join(out,'css/assets',cssName),'utf8')
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>市场设计预览 · 示例数据</title><style>${css}</style><div id="root"></div><script src="/harness.js"></script><script>const p=new URLSearchParams(location.search);document.documentElement.classList.toggle('dark',p.get('theme')==='dark');window.__mountScene(p.get('scene')||'market-browse-skill');</script></html>`
await writeFile(join(out,'index.html'),html)
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost')
    let body, type
    if(url.pathname==='/harness.js'){body=await readFile(join(out,'harness.js'));type='text/javascript'}
    else if(url.pathname.startsWith('/assets/') && assets.includes(basename(url.pathname))){body=await readFile(join(out,'css/assets',basename(url.pathname)));type=url.pathname.endsWith('.css')?'text/css':'font/woff2'}
    else if(url.pathname==='/' || url.pathname==='/market'){body=html;type='text/html; charset=utf-8'}
    else {res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':type});res.end(body)
  } catch {res.writeHead(500);res.end('preview failed')}
})
const serve=process.argv.includes('--serve')
await new Promise(r=>server.listen(serve?3014:0,'0.0.0.0',r))
const url=`http://127.0.0.1:${server.address().port}/market`
if(serve) console.log(`Marketplace preview (fixture data): ${url}`)
else {
 const browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:['--no-sandbox']})
 const errors=[];const unmocked=new Set();let checks=0
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  page.on('pageerror',e=>errors.push(e.message))
  page.on('console',msg=>{if(msg.text().startsWith('[unmocked-api]'))unmocked.add(msg.text())})
  for(const width of [1440,768,390,320]) for(const theme of ['light','dark']) {
    await page.setViewportSize({width,height:width<640?844:1000})
    await page.goto(`${url}?theme=${theme}`)
    await page.getByRole('heading',{name:'平台精选',exact:true}).waitFor()
    await page.evaluate(()=>document.fonts.ready)
    const overflow=await page.evaluate(()=>[...document.querySelectorAll('.marketplace-window,.marketplace-card,.marketplace-toolbar')].some(e=>e.scrollWidth>e.clientWidth+2))
    assert.equal(overflow,false,`overflow: ${width}/${theme}`);checks++
    assert.equal(await page.locator('.marketplace-card').count()>0,true);checks++
    await page.screenshot({path:join(out,`market-${width}-${theme}.png`)})
    await page.getByRole('button',{name:'办公文档',exact:true}).click()
    assert.equal(await page.locator('.marketplace-card:not([data-category="office-docs"])').count(),0);checks++
    await page.getByRole('button',{name:'返回全部',exact:true}).click()
    await page.getByRole('tab',{name:'智能体',exact:true}).click()
    await page.getByRole('searchbox',{name:'搜索智能体'}).waitFor();checks++
  }
  await page.setViewportSize({width:1440,height:1000})
  for (const scene of ['market-detail','market-detail-risky','market-detail-agent','market-installed','market-publish','market-review','market-browse-empty','market-browse-error','market-browse-loading']) {
    await page.goto(`${url}?scene=${scene}`)
    await page.locator('[role=dialog]').last().waitFor()
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(()=>window.__ocSceneError),null,scene);checks++
    await page.screenshot({path:join(out,`${scene}.png`)})
  }
  await page.goto(`${url}?scene=market-detail`)
  await page.getByRole('button',{name:'安装',exact:true}).click()
  await page.getByText(/安装成功|已安装/).first().waitFor();checks++
  // Radix keyboard dismissal restores the parent surface, not a dead overlay.
  await page.keyboard.press('Escape')
  await page.goto(url)
  await page.getByRole('heading',{name:'平台精选',exact:true}).waitFor()
  const first=page.locator('.marketplace-card').first()
  await first.focus();await page.keyboard.press('Enter')
  await page.locator('.marketplace-detail').waitFor();checks++
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.marketplace-detail').count(),0);checks++
  await page.getByRole('tab',{name:'已安装',exact:true}).click()
  await page.getByRole('heading',{name:'我的能力库'}).waitFor();checks++
  // Touch layout, form density and visualViewport keyboard/safe-area contract.
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
  mobile.on('pageerror',e=>errors.push(e.message))
  for(const scene of ['market-installed','market-publish','market-review','market-detail-risky']) {
    await mobile.goto(`${url}?scene=${scene}&theme=dark`)
    await mobile.locator('[role=dialog]').last().waitFor()
    await mobile.waitForTimeout(300)
    assert.equal(await mobile.evaluate(()=>[...document.querySelectorAll('[role=dialog]')].some(e=>e.scrollWidth>e.clientWidth+2)),false,scene);checks++
    await mobile.screenshot({path:join(out,`${scene}-mobile-dark.png`)})
  }
  await mobile.goto(url)
  await mobile.getByRole('searchbox').waitFor()
  await mobile.evaluate(()=>{document.documentElement.style.setProperty('--oc-visual-height','420px');document.documentElement.style.setProperty('--oc-visual-offset-top','80px')})
  const box=await mobile.locator('.marketplace-window').boundingBox()
  assert(box.y>=80 && box.y+box.height<=500,'visualViewport containment');checks++
  await mobile.getByRole('searchbox').fill('PPT')
  assert.equal(await mobile.locator('.marketplace-hero').count(),0);checks++
  await page.goto(`${url}?scene=market-detail`)
  await page.getByRole('button',{name:'安装',exact:true}).waitFor()
  await page.evaluate(()=>{window.__ocApiMocks.installMarketplace=async()=>{throw new Error('offline')}})
  await page.getByRole('button',{name:'安装',exact:true}).click()
  await page.getByText('操作没有完成',{exact:true}).waitFor();checks++
  await page.getByRole('button',{name:'重试',exact:true}).waitFor();checks++
  assert.deepEqual(errors,[])
  assert.equal(unmocked.size,0,`missing fixtures: ${[...unmocked]}`)
  await writeFile(join(out,'results.json'),JSON.stringify({checks,pageErrors:errors,viewports:[1440,768,390,320],themes:['light','dark']},null,2))
  console.log(`PASS: ${checks} browser checks; screenshots: ${out}`)
 } finally {await browser.close();server.close()}
}
