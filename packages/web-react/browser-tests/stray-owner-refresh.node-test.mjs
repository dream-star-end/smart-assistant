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
const ownerRed = process.env.OC_STRAY_OWNER_RED === "1";
const quietRed = process.env.OC_STRAY_QUIET_RED === "1";
assert.ok(!(ownerRed && quietRed));
const renderer = resolve(here, "../src/components/MessageRenderer.tsx");
const toolPath = resolve(here, "../src/components/ToolCard.tsx");
const sourcePaths = [here, resolve(here,"../src")].flatMap(root=>{
 const collect=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?collect(join(dir,entry.name)):[join(dir,entry.name)]);
 return collect(root);
}).sort();
const hashes = sourcePaths.map((p) => createHash("sha256").update(readFileSync(p)).digest("hex"));
let transforms = 0;
test("OCV5-313: actual App refresh preserves owner isolation and quiet failed steps", { timeout: 180000 }, async (t) => {
 const assetDir = mkdtempSync(join(tmpdir(), "oc-stray-owner-browser-"));
 await build({ entryPoints: [join(here, "process-disclosure-app-harness.tsx")], bundle: true, splitting: true, format: "esm", outdir: assetDir, entryNames: "app", chunkNames: "chunks/[name]-[hash]", jsx: "automatic",
 loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl" }, alias: { "node:crypto": join(here, "stubs/node-crypto.js") }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"MODE":"production","PROD":true,"DEV":false}' },
 plugins: ownerRed || quietRed ? [{ name: "one-causal-stray-consumer-ablation", setup(b) { b.onLoad({ filter: ownerRed ? /MessageRenderer\.tsx$/ : /ToolCard\.tsx$/ }, ({path}) => {
   assert.equal(resolve(path), ownerRed ? renderer : toolPath);
   const contents=readFileSync(path,"utf8");
   const needle=ownerRed ? "const renderableMessages = returnStrayRowsToOwnerTurn(safeMessages.filter(" : '<span className="text-faint">{status.label}</span>';
   assert.equal(contents.split(needle).length-1,1); transforms++;
   return {contents:contents.replace(needle, ownerRed ? "const renderableMessages = ((rows) => rows)(safeMessages.filter(" : '<span className="text-danger">{status.label}</span>'),loader:"tsx"};
 }); }}] : [], logLevel:"warning" });
 assert.equal(transforms,ownerRed || quietRed ? 1 : 0);
 const cssDir=join(assetDir,"css-build");mkdirSync(cssDir);
 await viteBuild({root:join(here,".."),configFile:false,logLevel:"silent",plugins:[tailwindcss()],build:{outDir:cssDir,emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:join(here,"preview-styles.ts"),output:{assetFileNames:"styles[extname]"}}}});
 writeFileSync(join(assetDir,"styles.css"),readFileSync(join(cssDir,readdirSync(cssDir).find(n=>n.endsWith(".css")))));
 const preview=await startPreviewServer(assetDir); let browser;
 const base=Date.now()-10000;
 const row=(id,role,text,extra={})=>({id,role,text,ts:base,_source:"server",...extra});
 const rows=[
 row("owner-u0","user","OWNER_OLDEST_USER",{status:"replied",ts:base-300000}),
 row("owner-a0","assistant","OWNER_OLDEST_ANSWER",{_clientMessageId:"owner-u0",ts:base-299000}),
 row("owner-u1","user","OWNER_PREVIOUS_USER",{status:"replied",ts:base-180000}),
 row("owner-first-tool","tool","终端",{_clientMessageId:"owner-u1",toolName:"Bash",inputJson:{command:"echo OWNER_EARLY"},_completed:true,output:"OWNER_EARLY_RESULT",ts:base-179000}),
 row("owner-mid","assistant","OWNER_PREVIOUS_PROGRESS",{_clientMessageId:"owner-u1",ts:base-178000}),
 row("owner-u2","user","OWNER_LATEST_USER",{status:"error",ts:base}),
 row("owner-stray-tool","tool","终端",{_clientMessageId:"owner-u1",toolName:"Bash",inputJson:{command:"echo OWNER_STRAY"},_completed:true,error:true,output:"OWNER_ORIGINAL_FAILED_OUTPUT",ts:base+1000}),
 row("owner-stray-final","assistant","OWNER_PREVIOUS_FINAL",{_clientMessageId:"owner-u1",ts:base+2000}),
 row("owner-old-ask","permission","OWNER_OLD_QUESTION",{_resolved:true,_behavior:"allow",requestId:"owner-resolved-ask",toolName:"AskUserQuestion",inputJson:{questions:[{question:"OWNER_OLD_QUESTION",options:[{label:"OWNER_ANSWER"}]}]},ts:base-298000}),
 row("owner-current-tool","tool","终端",{_clientMessageId:"owner-u2",toolName:"Bash",inputJson:{command:"echo OWNER_CURRENT"},_completed:true,output:"OWNER_CURRENT_RESULT",ts:base+3000}),
 row("owner-current-error","assistant","",{_clientMessageId:"owner-u2",_errorCode:"ENGINE_ERROR",_errorCardSnapshot:{disposition:"card",tone:"red",title:"OWNER_TERMINAL_ERROR",message:"OWNER_ORIGINAL_FINAL_ERROR"},ts:base+4000}),
 ];
 try {browser=await chromium.launch({executablePath:resolveBrowserExecutable(),headless:true,args:["--no-sandbox"]});
 for(const width of [1280,390]) await t.test(`${width} fresh and reload`,async()=>{
 preview.store.board=structuredClone(rows);preview.store.older=[];preview.store.revision++;
 const context=await browser.newContext({viewport:{width,height:950},isMobile:width===390,hasTouch:width===390});
 const page=await context.newPage();const errors=[];let responses=0;
 page.on("pageerror",e=>errors.push(e.message));page.on("response",r=>{if(new URL(r.url()).pathname===`/api/sessions/${BOARD_SESSION}`&&r.status()===200)responses++;});
 try {await page.goto(preview.url);
 for(const phase of ["fresh","reload"]){
 if(phase==="reload"){const before=responses;preview.store.revision++;await page.reload();await page.waitForFunction(()=>document.querySelectorAll("[data-testid=user-row]").length===3);assert.ok(responses>before);}
 await page.getByText("OWNER_LATEST_USER",{exact:true}).waitFor();
 await page.waitForFunction(async ([id, revision]) => {
 if (!(await indexedDB.databases()).some(db=>db.name==="ocv5_sessions__u1")) return false;
 const db=await new Promise((done,fail)=>{const q=indexedDB.open("ocv5_sessions__u1");q.onsuccess=()=>done(q.result);q.onerror=()=>fail(q.error);});
 try{if(!db.objectStoreNames.contains("sessions"))return false;return await new Promise((done,fail)=>{const q=db.transaction("sessions").objectStore("sessions").get(id);q.onsuccess=()=>done(q.result?._historyRevision===revision);q.onerror=()=>fail(q.error);});}finally{db.close();}
 }, [BOARD_SESSION, preview.store.revision]);
 await page.getByText("OWNER_LATEST_USER",{exact:true}).waitFor();
 const shells=page.getByTestId("process-disclosure");assert.equal(await shells.count(),3);
 const latest=shells.nth(2); const previous=shells.nth(1); const oldest=shells.nth(0);
 assert.equal(await latest.getByText(/OWNER_PREVIOUS_FINAL|OWNER_PREVIOUS_PROGRESS/).count(),0,"previous owner's rows must never live in latest shell");
 const final=page.getByText("OWNER_PREVIOUS_FINAL",{exact:true});await final.waitFor();assert.equal(await final.evaluate(n=>n.closest("[data-testid=process-disclosure]")),null,"previous terminal answer must remain top-level");
 assert.equal(await final.evaluate(n=>{const u=[...document.querySelectorAll("[data-testid=user-row]")].find(x=>x.textContent?.includes("OWNER_LATEST_USER"));return Boolean(u && (n.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING));}),true,"previous terminal answer must be before latest user, never under latest turn");
 assert.equal(await page.getByText("OWNER_OLD_QUESTION",{exact:true}).count(),0,"old resolved ask starts folded");
 for(const shell of [oldest,previous,latest]){const toggle=shell.getByTestId("process-toggle");if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();const detail=shell.getByTestId("process-detail-toggle");console.log("STRAY_DISCLOSURE_CONTROL",JSON.stringify({width,phase,owner:shell===previous ? "u1" : shell===oldest ? "u0" : "u2",detailControls:await detail.count()}));for(let i=0;i<await detail.count();i++){const control=detail.nth(i);if(await control.getAttribute("aria-expanded")!=="true")await control.click();}}
 assert.equal(await oldest.getByText("OWNER_OLD_QUESTION",{exact:true}).count(),1);
 assert.equal(await latest.getByText(/OWNER_OLD_QUESTION|OWNER_STRAY/).count(),0);
 assert.equal(await previous.getByTestId("tool-step").count(),2);
 const failed=previous.getByTestId("tool-step").filter({hasText:"未成功"});assert.equal(await failed.count(),1);
 const status=failed.getByText("未成功",{exact:true});await status.waitFor();
 const actualColor = await status.evaluate(n=>getComputedStyle(n).color);
 const commandColor = await failed.locator('span[title="echo OWNER_STRAY"]').evaluate(n=>getComputedStyle(n).color);
 assert.equal(actualColor,commandColor,"intermediate failure must use actual production faint process color");
 assert.equal(await status.evaluate(n=>n.classList.contains("text-faint")),true,"intermediate failed status must be quiet gray");
 assert.equal(await failed.locator("[class*=text-danger]").count(),0);
 const tool=failed.getByRole("button").first();if(await tool.getAttribute("aria-expanded")!=="true")await tool.click();
 const pre=failed.locator("pre");await pre.waitFor({state:"visible"});assert.equal((await pre.textContent()).split("\n").filter(line=>line==="OWNER_ORIGINAL_FAILED_OUTPUT").length,1);
 await page.getByText("OWNER_ORIGINAL_FINAL_ERROR",{exact:true}).waitFor();
 const terminal=page.getByText("OWNER_TERMINAL_ERROR",{exact:true});await terminal.waitFor();assert.equal(await terminal.evaluate(n=>n.closest("[data-testid=process-disclosure]")),null);assert.equal(await terminal.evaluate(n=>n.closest("[role=alert]")?.classList.contains("bg-danger-soft")),true);
 assert.deepEqual(preview.store.board,rows);assert.deepEqual(errors,[]);
 console.log("STRAY_OWNER_RECEIPT",JSON.stringify({width,phase,responses,ownerRows:2,oldResolvedAsk:1,quietFailedStep:1,terminalError:1,transforms}));
 }
 }catch(error){console.log("STRAY_OWNER_DIAGNOSTIC",JSON.stringify({width,responses,errors,body:(await page.locator("body").innerText()).slice(-7000)}));throw error;}finally{await context.close();}
 });
 }finally{await browser?.close();for(const ws of preview.wss.clients)ws.terminate();await new Promise(done=>preview.wss.close(done));await new Promise(done=>preview.server.close(done));assert.deepEqual(sourcePaths.map(p=>createHash("sha256").update(readFileSync(p)).digest("hex")),hashes);console.log("STRAY_SOURCE_PROVENANCE",JSON.stringify({sourceFiles:sourcePaths.length,sourceDigest:createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),ownerRed,quietRed,transforms}));}
});
