"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createRelay } = require("./relay.cjs");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const PATH = "/sand-stream-relay/aiserver.v1.InferenceService/Stream";
// Test-only UniversalClient adapter: real HTTP sockets, not the bundled Connect implementation.
// Box E2E separately verifies its exact createNodeHttpClient wiring.
function client(r) {
  return new Promise((resolve, reject) => {
    const q = http.request(r.url, { method: r.method, headers: Object.fromEntries(r.header), signal: r.signal }, s => resolve({ status: s.statusCode, header: new Headers(s.headers), body: s }));
    q.on("error", reject);
    (async () => { for await (const b of r.body) { if (!q.write(b)) await once(q, "drain"); } q.end(); })().catch(e => q.destroy(e));
  });
}
async function fixture(upstream, options = {}) {
  let tokenCalls = 0, transportCalls = 0;
  const back = http.createServer(upstream);
  await new Promise(r => back.listen(0, "127.0.0.1", r));
  const auth = { getGrokBotToken: async () => { tokenCalls++; return options.token ? options.token() : "BOX_TOKEN"; }, getMachineId: () => "MACHINE", backend: { backendUrl: "http://127.0.0.1:" + back.address().port, clientVersion: "0.44.0", boxNamespace: "prod" } };
  const relay = createRelay({ httpClient: r => { transportCalls++; return client(r); }, authorize: (q,t) => q.headers.authorization === "Bearer " + t, getAuth: () => auth, createChecksum: () => "CHECKSUM", allowTestHttp: true, maxConcurrent: 1, ...options });
  const gate = http.createServer((q,s) => relay({authToken: options.nullAuth ? null : "GATEWAY_TOKEN"},q,s));
  await new Promise(r => gate.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + gate.address().port + PATH;
  return { gate,back,url, stats: () => ({tokenCalls,transportCalls}), request: (more = {}) => fetch(url, { method:"POST", body:Buffer.from([0,0,0,0,0]), signal:AbortSignal.timeout(2500), ...more, headers:{"authorization":"Bearer GATEWAY_TOKEN", "content-type":"application/connect+proto",...more.headers} }), close:async()=>{gate.closeAllConnections();back.closeAllConnections();await Promise.all([new Promise(r=>gate.close(r)),new Promise(r=>back.close(r))]);} };
}
test("wrong, absent, and missing configured gateway auth: zero getter and upstream", async () => {
  for (const mode of ["wrong","absent","null"]) {
    const f=await fixture((q,s)=>s.end("bad"),{nullAuth:mode==="null"});
    try {const r=await f.request({headers:{authorization:mode==="absent"?"":"Bearer WRONG"}});assert.equal(r.status,401);await r.text();assert.deepEqual(f.stats(),{tokenCalls:0,transportCalls:0});} finally {await f.close();}
  }
});
test("authenticated empty capability probe returns loaded module hash with zero token or upstream calls", async () => {
  const f = await fixture((q, s) => s.end("must not reach upstream"), { maxConcurrent: undefined });
  const headers = { "x-oc-sand-box-probe": "1", "x-oc-sand-box-probe-nonce": "a".repeat(32) };
  try {
    const denied = await f.request({ body: "", headers: { ...headers, authorization: "Bearer WRONG" } });
    assert.equal(denied.status, 401); await denied.text();
    const bad = await f.request({ body: "x", headers });
    assert.equal(bad.status, 400); await bad.text();
    const result = await f.request({ body: "", headers });
    assert.equal(result.status, 200);
    const value = await result.json();
    assert.deepEqual(value, { protocol: "oc-sand-relay-v2", moduleSha256: createHash("sha256").update(readFileSync(require.resolve("./relay.cjs"))).digest("hex"), nonce: "a".repeat(32), active: 0, maxConcurrent: 4 });
    assert.deepEqual(f.stats(), { tokenCalls: 0, transportCalls: 0 });
  } finally { await f.close(); }
});
test("normal upload close does NOT cancel; complete multi-chunk response and secrets filtered", async () => {
  const request=Buffer.alloc(256*1024,7), expected=Buffer.alloc(256*1024,9);let received, headers;
  const f=await fixture(async(q,s)=>{headers=q.headers;const b=[];for await(const c of q)b.push(c);received=Buffer.concat(b);s.writeHead(200,{"content-type":"application/connect+proto","set-cookie":"BAD",authorization:"SHOULD_NOT_ESCAPE"});for(let n=0;n<expected.length;n+=4096){if(!s.write(expected.subarray(n,n+4096)))await once(s,"drain");}s.end();});
  try {const r=await f.request({body:request,headers:{cookie:"PRIVATE","x-anyrun-network-token":"NETWORK","x-inference-authentication-jwt":"BAD","x-cursor-client-type":"cursor"}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),expected);assert.deepEqual(received,request);assert.equal(headers.authorization,"Bearer BOX_TOKEN");assert.equal(headers["x-cursor-client-type"],"sand");for(const k of ["cookie","x-anyrun-network-token","x-inference-authentication-jwt"])assert.equal(headers[k],undefined);assert.equal(r.headers.get("set-cookie"),null);assert.equal(r.headers.get("authorization"),null);}finally{await f.close();}
});
test("client cancellation stops actual upstream stream", async () => {
  let ready;const started=new Promise(r=>ready=r);let closed;const stopped=new Promise(r=>closed=r);
  const f=await fixture(async(q,s)=>{q.resume();q.on("end",()=>{s.writeHead(200,{"content-type":"application/connect+proto"});s.write("first");ready();});s.on("close",closed);});
  const ctrl=new AbortController();
  try {const p=f.request({signal:ctrl.signal});await started;const r=await p;ctrl.abort();await assert.rejects(r.text());let timer;try{await Promise.race([stopped,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("upstream not stopped")),1000))]);}finally{clearTimeout(timer);}}finally{await f.close();}
});
test("credential failure and timeout: no upstream request", async () => {
  for(const timeout of [false,true]){const f=await fixture((q,s)=>s.end("bad"),{token:()=>timeout?new Promise(()=>{}):Promise.reject(Error("PRIVATE")),timeoutMs:40});try{const r=await f.request();assert.equal(r.status,timeout?504:503);assert.equal((await r.text()).includes("PRIVATE"),false);assert.equal(f.stats().transportCalls,0);}finally{await f.close();}}
});
test("body limit and concurrent request reject before additional token acquisition",async()=>{
  let release;const waiting=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);
  const f=await fixture(async(q,s)=>{q.resume();q.on("end",()=>s.end("ok"));},{maxBytes:10,token:async()=>{entered();await waiting;return "BOX_TOKEN";}});
  try{const too=await f.request({body:Buffer.alloc(11)});assert.equal(too.status,413);await too.text();assert.equal(f.stats().tokenCalls,0);const first=f.request();await ready;const second=await f.request();assert.equal(second.status,429);await second.text();assert.equal(f.stats().tokenCalls,1);release();const r=await first;assert.equal(await r.text(),"ok");}finally{release();await f.close();}
});
test("upstream HTTP and Connect errors preserved; redirects not followed",async()=>{
  for(const status of [401,200,302]){let calls=0;const bytes=(()=>{const body=Buffer.from(JSON.stringify({error:{code:"unauthenticated",message:"ticket rejected"}}));const prefix=Buffer.alloc(5);prefix[0]=2;prefix.writeUInt32BE(body.length,1);return Buffer.concat([prefix,body]);})();const f=await fixture((q,s)=>{calls++;q.resume();q.on("end",()=>{s.writeHead(status,{"content-type":"application/connect+proto",location:"http://127.0.0.1:1/forbidden"});s.end(bytes);});});try{const r=await f.request();assert.equal(r.status,status===302?502:status);if(status!==302)assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);else await r.text();assert.equal(calls,1);if(status!==302)assert.equal(r.headers.get("x-oc-sand-box-upstream"),"1");}finally{await f.close();}}
});
test("production transport rejects plaintext backend",async()=>{const f=await fixture((q,s)=>s.end("bad"),{allowTestHttp:false});try{const r=await f.request();assert.equal(r.status,503);await r.text();assert.equal(f.stats().transportCalls,0);}finally{await f.close();}});

test("default capacity admits four complete uploads; fifth gets local429 without upstream marker",async()=>{
 let started=0,ready;const barrier=new Promise(r=>ready=r);const pending=[];
 const f=await fixture(async(q,s)=>{q.resume();q.on("end",()=>{pending.push(s);if(++started===4)ready();});},{maxConcurrent:undefined});
 try{const requests=Array.from({length:4},()=>f.request());await barrier;const fifth=await f.request();assert.equal(fifth.status,429);assert.equal(fifth.headers.get("x-oc-sand-box-upstream"),null);await fifth.text();assert.deepEqual(f.stats(),{tokenCalls:4,transportCalls:4});for(const s of pending)s.end("four-ok");for(const p of requests){const r=await p;assert.equal(r.status,200);assert.equal(await r.text(),"four-ok");}}finally{for(const s of pending)if(!s.writableEnded)s.end();await f.close();}
});
