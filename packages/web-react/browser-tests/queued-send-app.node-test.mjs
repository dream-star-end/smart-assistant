import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build as viteBuild } from "vite";
import { startPreviewServer } from "./process-disclosure-app-server.mjs";
import { BOARD_SESSION } from "./process-disclosure-story.mjs";
import { resolveBrowserExecutable } from "../../../scripts/lib/resolve-browser.mjs";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const mode = process.env.OC_QUEUE_PROOF_RED || "";
assert.ok(["", "stream", "list"].includes(mode));
const appPath = resolve(here, "../src/App.tsx");
const messagePath = resolve(here, "../src/components/MessageRenderer.tsx");
const collect = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? collect(join(dir,e.name)) : [join(dir,e.name)]);
const inputs = [resolve(here, "../src"), here].flatMap(collect).sort();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const before = Object.fromEntries(inputs.map(p => [p, hash(readFileSync(p))]));
const digest = hash(JSON.stringify(before));
const changes = [];
const queuedText = "QUEUE_FULL_TEXT_" + "这段待发送的原文需要完整保留。".repeat(12);
const editedText = "QUEUE_EDITED_FULL_TEXT_" + "修改后的内容只能发送一次。".repeat(9);

async function until(label, read, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 30)); }
  throw new Error(label + ": timed out");
}
async function stored(page) {
  return page.evaluate(async id => {
    if (!(await indexedDB.databases()).some(db => db.name === "ocv5_sessions__u1")) return null;
    const db = await new Promise((done, fail) => { const q = indexedDB.open("ocv5_sessions__u1"); q.onsuccess=()=>done(q.result); q.onerror=()=>fail(q.error); });
    try {
      if (!db.objectStoreNames.contains("sessions")) return null;
      return await new Promise((done, fail) => { const q=db.transaction("sessions").objectStore("sessions").get(id); q.onsuccess=()=>done(q.result ?? null); q.onerror=()=>fail(q.error); });
    } finally { db.close(); }
  }, BOARD_SESSION);
}
test("INC-20260923-QUEUE-ABOVE-COMPOSER: real App queues, edits and stops before send-now", { timeout: 240000 }, async t => {
  const assets = mkdtempSync(join(tmpdir(), "queued-send-app-"));
  const plugins = mode ? [{ name: "only-queue-display-guards", setup(b) {
    b.onLoad({ filter: /\/(App|MessageRenderer)\.tsx$/ }, ({ path }) => {
      const actual = resolve(path);
      if (![appPath, messagePath].includes(actual)) return;
      let text = readFileSync(actual, "utf8");
      let needle, replacement;
      if (mode === "stream" && actual === appPath) {
        needle = '  const timelineMessages = wsMessages.filter(\n    (message) => message.role !== "user" || message.status !== "queued",\n  );';
        replacement = "  const timelineMessages = wsMessages;";
      } else if (mode === "stream" && actual === messagePath) {
        needle = '  messages = messages.filter((message) => message.role !== "user" || message.status !== "queued");';
        replacement = "  messages = messages;";
      } else if (mode === "list" && actual === appPath) {
        needle = "{!demo && !gated && queuedOutgoing.length > 0 && (";
        replacement = "{false && !demo && !gated && queuedOutgoing.length > 0 && (";
      } else return;
      assert.equal(text.split(needle).length - 1, 1);
      const red = text.replace(needle, replacement);
      changes.push({ path: actual, before: hash(text), consumed: hash(red) });
      return { contents: red, loader: "tsx" };
    });
  }}] : [];
  await build({ entryPoints:[join(here,"process-disclosure-app-harness.tsx")], bundle:true, splitting:true, format:"esm", outdir:assets, entryNames:"app", chunkNames:"chunks/[name]-[hash]", jsx:"automatic", loader:{".css":"empty",".svg":"dataurl",".png":"dataurl",".jpg":"dataurl",".webp":"dataurl"}, alias:{"node:crypto":join(here,"stubs/node-crypto.js")}, define:{"process.env.NODE_ENV":'"production"',"import.meta.env":'{"MODE":"production","PROD":true,"DEV":false}'}, plugins, logLevel:"warning" });
  assert.equal(changes.length, mode === "stream" ? 2 : mode === "list" ? 1 : 0);
  console.log("QUEUE_BUILD", JSON.stringify({ mode, digest, inputs:inputs.length, changes }));
  const cssDir=join(assets,"css");mkdirSync(cssDir);
  await viteBuild({ root:join(here,".."), configFile:false, logLevel:"silent", plugins:[tailwindcss()], build:{outDir:cssDir,emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:join(here,"preview-styles.ts"),output:{assetFileNames:"styles[extname]"}}} });
  writeFileSync(join(assets,"styles.css"),readFileSync(join(cssDir,readdirSync(cssDir).find(p=>p.endsWith(".css")))));
  const preview=await startPreviewServer(assets);
  preview.wss.removeAllListeners("connection");
  let scenario;
  preview.wss.on("connection",ws=>{
    const send=frame=>ws.readyState===1 && ws.send(JSON.stringify(frame));
    send({type:"sys.relay_ready",automaticRecoveryOwner:"master-v1"});
    ws.on("message",raw=>{
      const frame=JSON.parse(String(raw)),peer={id:BOARD_SESSION,kind:"dm"};
      if(frame.type==="ping")return send({type:"pong",id:frame.id});
      if(frame.type==="inbound.hello")return send({type:"sys.relay_ready",automaticRecoveryOwner:"master-v1"});
      if(frame.type==="inbound.control.stop"){
        scenario.stops.push(frame);
        send({type:"outbound.control.receipt",peer,controlId:frame.controlId,controlKind:"stop",clientMessageId:frame.clientMessageId,status:"applied"});
        scenario.releaseOriginal=()=>{
          scenario.terminal=true;
          send({type:"outbound.control.receipt",peer,controlId:frame.controlId,controlKind:"stop",clientMessageId:frame.clientMessageId,status:"terminal"});
        };
        return;
      }
      if(frame.type!=="inbound.message")return;
      scenario.inbound.push(frame);
      const id=frame.clientMessageId;
      send({type:"outbound.ack",admitted:true,peer,clientMessageId:id});
      if(scenario.inbound.length===1){
        scenario.first=id;
        send({type:"outbound.message",peer,clientMessageId:id,frameSeq:++scenario.seq,blocks:[{kind:"text",text:"QUEUE_ORIGINAL_WORK_VISIBLE",messageId:"queue-original-body"}],isFinal:false});
        send({type:"outbound.message",peer,clientMessageId:id,frameSeq:++scenario.seq,blocks:[{kind:"tool_use",blockId:"queue-running-tool",messageId:"queue-running-tool",toolName:"Bash",partial:false,inputJson:{command:"echo QUEUE_ORIGINAL_TOOL"}}],isFinal:false});
      }else{
        scenario.afterTerminal.push(scenario.terminal);
        send({type:"outbound.message",peer,clientMessageId:id,frameSeq:++scenario.seq,blocks:[{kind:"text",text:"QUEUE_EDITED_REPLY_COMPLETED",messageId:"queue-edited-body"}],isFinal:true});
      }
    });
  });
  let browser;
  try{
    browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:["--no-sandbox"]});
    for(const width of [1280,390])await t.test(width+" queued outside transcript; full edit and stop-terminal-before-dispatch",async()=>{
      scenario={inbound:[],stops:[],terminal:false,afterTerminal:[],seq:0,first:null,releaseOriginal:null};
      preview.store.board=[];preview.store.older=[];preview.store.revision+=1;
      const context=await browser.newContext({viewport:{width,height:950},isMobile:width===390,hasTouch:width===390});
      const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
      try{
        await page.goto(preview.url);
        const composer=page.getByPlaceholder(/对话/);
        await composer.fill("QUEUE_FIRST_REQUEST");
        await page.getByRole("button",{name:"发送",exact:true}).click();
        await until("first real WS dispatch",()=>scenario.inbound.length===1);
        await page.getByRole("button",{name:"停止",exact:true}).waitFor();
        await composer.fill(queuedText);
        await page.getByRole("button",{name:"排队发送",exact:true}).click();
        const saved=await until("actual IDB queued user",async()=>{const row=(await stored(page))?.messages.find(m=>m.role==="user"&&m.text===queuedText&&m.status==="queued");return row;});
        assert.equal(scenario.inbound.length,1,"queued user must not dispatch in active turn");
        const inTimeline=await page.getByTestId("user-row").filter({hasText:queuedText}).count();
        assert.equal(inTimeline,0,"queued message must remain outside the actual transcript");
        const list=page.getByTestId("queued-send-list");
        assert.equal(await list.count(),1,"actual IDB queue must render one list above Composer");
        const row=list.getByTestId("queued-send-row");
        assert.equal(await row.count(),1);
        assert.equal((await row.locator("p").textContent()).trim(),queuedText);
        const edit=row.getByRole("button",{name:"修改",exact:true}),now=row.getByRole("button",{name:"立即发送",exact:true});
        assert.equal(await edit.count(),1);assert.equal(await now.count(),1);
        const geometry=await row.evaluate(el=>{
          const p=el.querySelector("p"),buttons=el.querySelectorAll("button"),list=el.closest('[data-testid="queued-send-list"]'),textarea=document.querySelector("textarea");
          const r=x=>{const y=x.getBoundingClientRect();return {top:y.top,bottom:y.bottom,left:y.left,right:y.right,height:y.height};};
          return {p:r(p),buttons:[...buttons].map(r),list:r(list),composer:r(textarea),outsideChatScroller:list.closest(".chat-scroll-area")===null,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};
        });
        assert.equal(geometry.outsideChatScroller,true,"queue list must live outside the message scroll container");
        assert.ok(geometry.list.bottom<=geometry.composer.top+1,"queue list must be above Composer");
        assert.ok(geometry.p.right<=geometry.buttons[0].left+1,"queue actions must be on right");
        assert.ok(geometry.scrollWidth<=geometry.viewport+1,"queue must not create horizontal overflow");
        if(width===390)assert.ok(geometry.buttons.every(b=>b.height>=44),"mobile queue buttons retain touch targets");
        await edit.click();
        assert.equal(await composer.inputValue(),queuedText,"editing restores the full untruncated text");
        await until("queue removed durably after edit",async()=>{const session=await stored(page);return session!==null && !session.messages.some(m=>m.id===saved.id);});
        assert.equal(await list.count(),0);assert.equal(scenario.inbound.length,1);
        await composer.fill(editedText);
        await page.getByRole("button",{name:"排队发送",exact:true}).click();
        await until("edited text durable queued",async()=>(await stored(page))?.messages.some(m=>m.text===editedText&&m.status==="queued"));
        await list.getByRole("button",{name:"立即发送",exact:true}).click();
        await until("real stop control applied",()=>scenario.stops.length===1&&typeof scenario.releaseOriginal==="function");
        await page.getByRole("button",{name:"正在停止",exact:true}).waitFor();
        assert.equal(scenario.inbound.length,1,"send-now must wait for original turn terminal");
        assert.equal(scenario.stops[0].clientMessageId,scenario.first);
        scenario.releaseOriginal();
        await until("edited real WS dispatch after terminal",()=>scenario.inbound.length===2);
        assert.deepEqual(scenario.afterTerminal,[true]);
        assert.equal(scenario.inbound[1].content.text,editedText);
        await page.getByText("QUEUE_EDITED_REPLY_COMPLETED",{exact:true}).waitFor();
        assert.equal(await list.count(),0);
        assert.equal(await page.getByTestId("user-row").filter({hasText:editedText}).count(),1);
        const original=page.getByText("QUEUE_ORIGINAL_WORK_VISIBLE",{exact:true});
        assert.equal(await original.count(),1,"the original work remains in its owned row");
        if (!(await original.isVisible())) {
          const shell=original.locator('xpath=ancestor::*[@data-testid="process-disclosure"][1]');
          assert.equal(await shell.count(),1,"hidden original work has one disclosure owner");
          const toggle=shell.getByTestId("process-toggle");
          if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();
        }
        await original.waitFor({state:"visible"});
        assert.equal(scenario.stops.length,1);assert.equal(scenario.inbound.length,2);assert.deepEqual(errors,[]);
        console.log("QUEUE_RECEIPT",JSON.stringify({width,mode,digest,changes,queuedId:saved.id,original:scenario.first,queueOnly:true,fullTextPreserved:true,geometry,stopControls:1,dispatchAfterTerminal:scenario.afterTerminal,dispatches:2}));
      }finally{await context.close();}
    });
  }finally{
    if(browser)await browser.close();
    await new Promise(done=>preview.wss.close(()=>preview.server.close(done)));
    for(const path of inputs)assert.equal(hash(readFileSync(path)),before[path],"source changed during queue proof");
  }
});
