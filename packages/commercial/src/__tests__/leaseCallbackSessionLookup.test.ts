import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupLeaseCallbackSession } from "../db/pgSessionsBackend.js";
import { executeCronOriginInject } from "../ws/userChatBridge.js";
test("lease ownership lookup uses scoped metadata only, and distinguishes foreign/gone", async () => {
  for (const [own, other, expected] of [[[{deleted_at:null}], [], "owned"], [[{deleted_at:123}], [], "gone"], [[], [{}], "foreign"], [[], [], "gone"]] as const) {
    const queries: {sql:string; args:unknown}[]=[];
    const pool={query:async (sql:string,args:unknown) => {queries.push({sql,args}); return {rows:queries.length===1?own:other};}};
    assert.equal(await lookupLeaseCallbackSession(pool as any,"3","webtest"),expected);
    assert.deepEqual(queries[0]?.args,["webtest","c:3"]);
    assert.match(queries[0]!.sql,/SELECT deleted_at/);
    assert.ok(queries.every(x=>!x.sql.includes("messages")&&!x.sql.includes("tape")));
    assert.equal(queries.length,own.length?1:2);
  }
});
test("durable admission dedup ACK does not invoke a second executor", async () => {
  let executes=0;
  const input={uid:3n, sessionId:"webtest",clientMessageId:"lsc-test",text:"failure",agentId:"main"};
  const result=await executeCronOriginInject({
    input,lookupSessionModel:async()=>"grok-build",
    admitUserTurn:async(args:any)=>{assert.equal(args.model,"grok-build");assert.equal(args.clientMessageId,"lsc-test");return {kind:"deduplicated"} as any;},
    executor:async()=>{executes++;throw Error("must not execute");},
  });
  assert.equal(result.kind,"injected");assert.equal(executes,0);
});
