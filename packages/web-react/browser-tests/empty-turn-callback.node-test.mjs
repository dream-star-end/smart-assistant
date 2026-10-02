import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { WebSocket } from "ws";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { BOARD_SESSION } from "./process-disclosure-story.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name==="node_modules" ? [] : e.isDirectory() ? files(join(dir,e.name)) : [join(dir,e.name)]); }
const inputs = [...files(resolve(here, "../src")), ...files(here), ...files(join(root,"packages/gateway/src")), ...files(join(root,"packages/storage/src")), ...files(join(root,"packages/protocol/src"))].sort();
const hashes = () => Object.fromEntries(inputs.map(p=>[p,createHash("sha256").update(readFileSync(p)).digest("hex")]));
const before = hashes();
const digest = createHash("sha256").update(JSON.stringify(before)).digest("hex");
async function until(label, fn, timeout=15000) { const end=Date.now()+timeout; while(Date.now()<end) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,30)); } throw new Error(label+": timeout"); }
const receipts = [];
test("INC-20260923-EMPTY-TURN-NO-REPLY: actual Gateway engine terminal and callback admission", {timeout:240000}, async t => {
  const assetDir=mkdtempSync(join(tmpdir(),"oc-empty-browser-"));
  await build({ entryPoints:[join(here,"process-disclosure-app-harness.tsx")],bundle:true,splitting:true,format:"esm",outdir:assetDir,entryNames:"app",chunkNames:"chunks/[name]-[hash]",jsx:"automatic",loader:{".css":"empty",".svg":"dataurl",".png":"dataurl",".jpg":"dataurl",".webp":"dataurl"},alias:{"node:crypto":join(here,"stubs/node-crypto.js")},define:{"process.env.NODE_ENV":'"production"',"import.meta.env":'{"MODE":"production","PROD":true,"DEV":false}'},logLevel:"warning" });
  const cssDir=join(assetDir,"css-build");mkdirSync(cssDir);
  await viteBuild({root:join(here,".."),configFile:false,logLevel:"silent",plugins:[tailwindcss()],build:{outDir:cssDir,emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:join(here,"preview-styles.ts"),output:{assetFileNames:"styles[extname]"}}}});
  writeFileSync(join(assetDir,"styles.css"),readFileSync(join(cssDir,readdirSync(cssDir).find(n=>n.endsWith(".css")))));
  const home=mkdtempSync(join(tmpdir(),"oc-empty-engine-"));
  const child=spawn(process.execPath,["--import","tsx",join(here,"empty-turn-gateway.fixture.ts")],{cwd:root,env:{PATH:process.env.PATH,HOME:home,OPENCLAUDE_HOME:home,LANG:"C.UTF-8"},stdio:["ignore","pipe","pipe"]});
  let childOut="",childErr="";
  child.stdout.on("data",b=>childOut+=b);child.stderr.on("data",b=>childErr+=b);
  let preview,browser;
  async function control(path,args={}) { const response=await fetch(engine.url+path,{method:"POST",body:JSON.stringify(args)}); const body=await response.json(); assert.equal(response.status,200,JSON.stringify(body));return body; }
  let engine;
  const wires=[];
  const proxies=new Set();
  try {
    const ready=await until("isolated fixture startup",()=> { if(child.exitCode!==null)throw new Error(childOut+"\n"+childErr); return /OC_EMPTY_READY (\{[^\n]+\})/.exec(childOut+"\n"+childErr)?.[1]; },60000);
    engine=JSON.parse(ready);
    assert.equal(engine.tree,resolve(root,"packages"));
    preview=await startPreviewServer(assetDir);
    preview.wss.removeAllListeners("connection");
    preview.wss.on("connection",ws=>{
      const backend=new WebSocket(engine.url.replace("http:","ws:"));proxies.add(backend);
      const pending=[];
      ws.on("message",raw=>backend.readyState===1?backend.send(raw,{binary:false}):pending.push(raw));
      backend.on("open",()=>{for(const raw of pending)backend.send(raw,{binary:false});pending.length=0;});
      backend.on("message",raw=>{wires.push(JSON.parse(String(raw)));if(ws.readyState===1)ws.send(raw,{binary:false});});
      ws.on("close",()=>{backend.close();proxies.delete(backend);});
    });
    browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:["--no-sandbox"]});
    for(const [width,mode] of [[1280,"empty"],[390,"empty"],[1280,"nonempty"]]) await t.test(`${width} actual engine ${mode} terminal and App controls`,async()=>{
      const baseline=await control("/reset",{peer:BOARD_SESSION,mode});
      preview.store.board=[];preview.store.older=[];preview.store.revision++;
      const context=await browser.newContext({viewport:{width,height:950},isMobile:width===390,hasTouch:width===390});
      const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
      const start=wires.length;
      try {
        await page.goto(preview.url);
        await page.getByPlaceholder(/对话/).fill("EMPTY_REAL_COMPOSER_REQUEST");
        await page.getByRole("button",{name:"发送",exact:true}).click();
        await until("actual engine terminal delivery",()=>wires.slice(start).some(f=>f.isFinal));
        const snap=await control("/snapshot",{peer:BOARD_SESSION});
        const leaf=snap.allPayloads.at(-1);
        assert.equal(snap.inputCount,1,"one true external engine submit, not a replay");
        assert.equal(snap.turns,baseline.turns+1,"real durable turn index advances once");
        assert.equal(snap.originalStarted,false);
        assert.equal(leaf.sessionId,BOARD_SESSION);
        const cmid=wires.slice(start).find(f=>f.isFinal)?.clientMessageId;
        assert.equal(leaf.clientMessageId,cmid,"actual sink and actual wire share owner");
        if(mode==="empty") {
          // Gather UI receipt before terminal oracle so negative control distinguishes fake success.
          const title=page.getByText("模型服务暂时中断",{exact:true});
          await until("App consumes actual terminal",async()=>await title.count()>0||await page.getByText("这轮没有回复",{exact:true}).count()>0);
          const ui={errorTitles:await title.count(),fakeBody:await page.getByText("本轮未能产出可见回复，已结束，可重试或继续",{exact:true}).count(),ratings:await page.locator('[aria-label="点赞"],[aria-label="点踩"]').count(),operations:await page.getByTestId("assistant-row").getByRole("button",{name:"更多操作",exact:true}).count()};
          receipts.push({width,mode,baseline,ui,snap,wire:wires.slice(start)});
          assert.equal(leaf.status,"crashed","empty must not be a persisted successful turn");
          assert.equal(leaf.errorCode,"NO_RESPONSE");
          assert.equal(leaf.waiveReason,"no_response");
          assert.equal(leaf.text??"","");
          assert.ok(ui.errorTitles>0,"actual error disclosure must render");
          assert.equal(ui.fakeBody,0);
          assert.equal(ui.ratings,0);
          assert.equal(ui.operations,0);
        } else {
          await page.getByText("EMPTY_NONEMPTY_REAL_ANSWER",{exact:true}).waitFor();
          const answerRow=page.getByTestId("assistant-row").filter({hasText:"EMPTY_NONEMPTY_REAL_ANSWER"});
          await answerRow.hover();
          await answerRow.getByRole("button",{name:"引用",exact:true}).waitFor();
          assert.equal(leaf.status,"completed");
          assert.equal(leaf.text,"EMPTY_NONEMPTY_REAL_ANSWER");
          assert.equal(leaf.errorCode??null,null);
          assert.equal(await page.getByText("这轮没有回复",{exact:true}).count(),0);
          // Real rating context must remain enabled, not fixture-hidden.
          assert.equal(await page.getByRole("button",{name:"点赞",exact:true}).count(),1);
          receipts.push({width,mode,baseline,snap,wire:wires.slice(start)});
        }
        assert.deepEqual(errors,[]);
        assert.deepEqual(await control("/failures"),[]);
      } finally {await context.close();}
    });
    await t.test("stopped duplicate suppressed while different summary and session scope admit real turns",async()=>{
      const p1="wsess-0123456789abc101",p2="wsess-0123456789abc102";
      for(const peer of [p1,p2])await control("/reset",{peer,mode:"nonempty"});
      const note=(taskId,summary)=>({taskId,status:"stopped",outputFile:"",summary});
      const first=await control("/notify",{peer:p1,notification:note("stopped-1","EMPTY_STOP_SUMMARY_A")});
      const duplicate=await control("/notify",{peer:p1,notification:note("stopped-2","EMPTY_STOP_SUMMARY_A")});
      const different=await control("/notify",{peer:p1,notification:note("stopped-3","EMPTY_STOP_SUMMARY_B")});
      const scoped=await control("/notify",{peer:p2,notification:note("stopped-4","EMPTY_STOP_SUMMARY_A")});
      receipts.push({callback:{first,duplicate,different,scoped}});
      const rows=x=>x.stored.messages.filter(m=>m.role==="user");
      assert.equal(first.inputCount,1);assert.equal(first.turns,1);assert.equal(rows(first).length,1);
      assert.equal(first.callbackState,"delivered");assert.match(rows(first)[0].text,/EMPTY_STOP_SUMMARY_A/);
      assert.equal(duplicate.inputCount,1,"same notice must not admit a second real engine turn");
      assert.equal(duplicate.turns,1);assert.deepEqual(rows(duplicate),rows(first));
      assert.equal(different.inputCount,2);assert.equal(different.turns,2);assert.equal(rows(different).length,2);assert.match(rows(different)[1].text,/EMPTY_STOP_SUMMARY_B/);
      assert.equal(scoped.inputCount,1);assert.equal(scoped.turns,1);assert.equal(rows(scoped).length,1);assert.match(rows(scoped)[0].text,/EMPTY_STOP_SUMMARY_A/);
      for(const snap of [first,duplicate,different,scoped]) {assert.equal(snap.originalStarted,false);assert.deepEqual(snap.active,[0,0]);}
      assert.deepEqual(await control("/failures"),[]);
    });
  } finally {
    if(browser)await browser.close();
    if(preview){for(const ws of preview.wss.clients)ws.terminate();for(const ws of proxies)ws.terminate();await new Promise(r=>preview.wss.close(r));await new Promise(r=>preview.server.close(r));}
    child.kill("SIGTERM");
    await until("isolated fixture shutdown",()=>child.exitCode!==null||child.signalCode!==null,12000);
    assert.deepEqual(hashes(),before,"all actual consumer and App source bytes frozen");
    const result={digest,inputFiles:inputs.length,engine,receipts,childOut,childErr};
    if(process.env.OC_EMPTY_RECEIPT_PATH)writeFileSync(process.env.OC_EMPTY_RECEIPT_PATH,JSON.stringify(result,null,2));
    console.log("EMPTY_GATEWAY_PROVENANCE",JSON.stringify({digest,inputFiles:inputs.length,leaves:receipts.length}));
  }
});
