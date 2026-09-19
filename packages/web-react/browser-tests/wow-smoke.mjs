import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,stat,mkdir,writeFile} from 'node:fs/promises'
import {resolve,extname,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright-core'
import {resolveBrowserExecutable} from '../../../scripts/lib/resolve-browser.mjs'
const root=resolve('public'),out=resolve(process.env.WOW_SHOTS||'/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-172-shots')
await mkdir(out,{recursive:true})
const server=createServer(async(req,res)=>{try{const p=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));if(!p.startsWith(root+sep)||!(await stat(p)).isFile())throw Error();res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png'})[extname(p)]||'application/octet-stream');res.end(await readFile(p))}catch{res.writeHead(404);res.end()}})
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:['--enable-unsafe-swiftshader']})
const results=[]
try{
for(const width of [1440,390]){
const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE_ERROR',e.message)});console.log('BEGIN',width)
await page.goto(base+'/tutorials/showcase-works/planet/index.html')
await page.waitForFunction(()=>window.__planet?.rendered>2)
if(await page.getByRole('button',{name:'暂停自转',exact:true}).isVisible())await page.getByRole('button',{name:'暂停自转',exact:true}).click()
const before=await page.locator('canvas').screenshot()
await page.getByRole('button',{name:'新世界 ↗',exact:true}).click()
await page.waitForFunction(()=>window.__planet.state.seed===54)
await page.waitForFunction(()=>window.__planet.rendered>5)
await page.waitForTimeout(250)
const after=await page.locator('canvas').screenshot()
assert.notEqual(createHash('sha256').update(before).digest('hex'),createHash('sha256').update(after).digest('hex'),'new terrain must change rendered pixels')
await page.selectOption('#biome','2');assert.equal(await page.evaluate(()=>window.__planet.state.biome),2)
await page.selectOption('#biome','0')
await page.locator('#sun').focus();await page.keyboard.press('End');assert.ok(await page.evaluate(()=>window.__planet.state.sun>3))
await page.locator('#sun').evaluate(e=>{e.value='35';e.dispatchEvent(new Event('input',{bubbles:true}))})
await page.screenshot({path:out+'/planet-'+width+'.png',fullPage:true});if(width===1440)await page.locator('canvas').screenshot({path:root+'/tutorials/showcase-works/planet/cover.png'})
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
assert.deepEqual(errors,[]);results.push({work:'planet',width,webgl:true,pixelChange:true,controls:true,errors})
await page.goto(base+'/tutorials/showcase-works/gravity/index.html');await page.waitForFunction(()=>window.__gravity?.time>3)
await page.getByRole('button',{name:'暂停模拟'}).click();const t=await page.evaluate(()=>window.__gravity.time)
await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__gravity.time),t)
await page.locator('#mass').focus();await page.keyboard.press('End');assert.equal(await page.evaluate(()=>window.__gravity.bodies[0].m),3)
await page.selectOption('#preset','eight');await page.getByRole('button',{name:'继续模拟'}).click();await page.waitForFunction(()=>window.__gravity.time>5)
await page.screenshot({path:out+'/gravity-'+width+'.png',fullPage:true});if(width===1440)await page.locator('canvas').screenshot({path:root+'/tutorials/showcase-works/gravity/cover.png'})
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
assert.deepEqual(errors,[]);results.push({work:'gravity',width,simulation:true,pause:true,mass:true,errors});await page.close()
}
const p=await browser.newPage({viewport:{width:1000,height:800}})
await p.goto(base+'/tutorials/showcase-works/planet/index.html')
await p.setContent('<iframe title="physics" sandbox="allow-scripts" src="'+base+'/tutorials/showcase-works/gravity/index.html" style="width:900px;height:700px"></iframe>')
await p.frameLocator('iframe').locator('#time').filter({hasText:/[1-9]/}).waitFor({timeout:15000})
assert.equal(await p.locator('iframe').getAttribute('sandbox'),'allow-scripts');results.push({work:'gravity',opaqueSandbox:true});await p.close()
await writeFile(out+'/results.json',JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));console.log(JSON.stringify(results))
}finally{await browser.close();server.close()}
