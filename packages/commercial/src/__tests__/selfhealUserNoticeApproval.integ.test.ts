import * as assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createPool, closePool, resetPool, setPoolOverride } from "../db/index.js";
import { query } from "../db/queries.js";
import { runMigrations } from "../db/migrate.js";
import { startUserNoticeApproval } from "../selfheal/userNoticeApproval.js";
import { recordUserImpact } from "../selfheal/userImpact.js";
import type { AibotInboundHandler, AibotInboundMessage, WecomAibotConnectionManager } from "../admin/wecomAibotConnection.js";

const DB = process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
let available = false;
async function probe() {
  const p=createPool({connectionString:DB,max:1,connectionTimeoutMillis:1000});
  try { await p.query("SELECT 1"); await p.end(); return true; } catch { await p.end().catch(()=>{}); return false; }
}

before(async()=>{
  process.env.OPENCLAUDE_KMS_KEY=Buffer.alloc(32,0x67).toString("base64");
  available=await probe(); if(!available) return;
  await resetPool(); setPoolOverride(createPool({connectionString:DB,max:10})); await runMigrations();
});
after(async()=>{ if(available) await closePool(); });
beforeEach(async()=>{
  if(!available) return;
  await query(`TRUNCATE selfheal_wecom_inbound_dedupe,selfheal_user_notice_recipients,
    selfheal_user_notice_proposals,selfheal_notice_approver_bindings,selfheal_user_impact_evidence,
    codex_repair_events,codex_repairs,incidents,admin_alert_rule_state,admin_alert_channels,users
    RESTART IDENTITY CASCADE`);
});

async function seed() {
  const admin=(await query<{id:string}>(`INSERT INTO users(email,password_hash,credits,role,status)
    VALUES('notice-admin@test.local','x',0,'admin','active') RETURNING id::text`)).rows[0].id;
  const user=(await query<{id:string}>(`INSERT INTO users(email,password_hash,credits,role,status)
    VALUES('notice-user@test.local','x',0,'user','active') RETURNING id::text`)).rows[0].id;
  const ch=(await query<{id:string}>(`INSERT INTO admin_alert_channels
    (admin_id,channel_type,label,enabled,severity_min,event_types,aibot_bot_id,activation_status)
    VALUES($1,'wecom_aibot','approval',TRUE,'info','[]','bot-notice-test','active') RETURNING id::text`,[admin])).rows[0].id;
  const policy=(await query<{id:string}>(`UPDATE incident_policies SET user_notice_enabled=TRUE,auto_repair=TRUE
    WHERE match_kind='prefix' AND match_key='ops.monitor:svc_v5' RETURNING id::text`)).rows[0].id;
  const inc=(await query<{id:string}>(`INSERT INTO incidents
    (dedupe_key,condition_key,policy_id,status,severity,surface,audience,user_title,user_message,resolve_source,resolved_at)
    VALUES('ops.monitor:svc_v5','ops.monitor:svc_v5',$1,'repairing','critical','global','all',
      '服务已恢复','请继续使用。',NULL,NULL) RETURNING id::text`,[policy])).rows[0].id;
  await query(`INSERT INTO admin_alert_rule_state
    (rule_id,firing,mode,level,snapshot,observed_at,observation_seq,condition_rev,occurrence_count)
    VALUES('ops.monitor:svc_v5',TRUE,'probe','critical','{}',NOW(),1,1,1)`);
  const rep=(await query<{id:string}>(`INSERT INTO codex_repairs
    (incident_id,status,attempt,tier,verify_after,finished_at)
    VALUES($1,'succeeded',1,'tier2',NOW()-INTERVAL '5 seconds',NOW()) RETURNING id::text`,[inc])).rows[0].id;
  const att={trusted_attestation:{version:1,repairId:rep,incidentId:inc,
    conditionKey:'ops.monitor:svc_v5',target:'service:v5',action:'deploy_v5',
    executionMode:'fully_automatic',executed:true,
    remoteResult:{ok:true,target:'service:v5',healthOk:true,checkedAt:new Date().toISOString()}}};
  await query(`INSERT INTO codex_repair_events(repair_id,kind,message,detail)
    VALUES($1,'done','deployed',$2::jsonb)`,[rep,JSON.stringify(att)]);
  assert.equal(await recordUserImpact({conditionKey:'ops.monitor:svc_v5',userId:BigInt(user),
    requestId:'req-1',target:'service:v5',failureCode:'SERVICE_UNAVAILABLE'}),true);
  const ev=(await query<{id:string}>(`SELECT id::text FROM selfheal_user_impact_evidence
    WHERE incident_id=$1 AND user_id=$2`,[inc,user])).rows[0].id;
  await query(`SELECT * FROM write_alert_condition($1,'probe',FALSE,'critical','{}'::jsonb,NOW(),NULL,0)`,
    ['ops.monitor:svc_v5']);
  await query(`UPDATE incidents SET status='resolved',resolve_source='codex',resolved_at=NOW() WHERE id=$1`,[inc]);
  await query(`INSERT INTO selfheal_notice_approver_bindings
    (channel_id,chat_id,chat_type,from_user_id,binding_code,active,bound_at)
    VALUES($1,'chat-dx','single','dx-wecom','A1B2C3D4',TRUE,NOW())`,[ch]);
  return {user,ch,inc,rep,ev};
}

describe("selfheal user notice approval end-to-end",()=>{
  test("accepts an exact binding command after the WeCom group mention prefix",async(t)=>{
    if(!available){t.skip("pg unavailable");return;}
    const admin=(await query<{id:string}>(`INSERT INTO users(email,password_hash,credits,role,status)
      VALUES('binding-admin@test.local','x',0,'admin','active') RETURNING id::text`)).rows[0].id;
    const ch=(await query<{id:string}>(`INSERT INTO admin_alert_channels
      (admin_id,channel_type,label,enabled,severity_min,event_types,aibot_bot_id,activation_status)
      VALUES($1,'wecom_aibot','approval',TRUE,'info','[]','bot-binding-test','active') RETURNING id::text`,[admin])).rows[0].id;
    let inbound:AibotInboundHandler=async()=>null;
    const manager={setInboundHandler(h:AibotInboundHandler|null){if(h) inbound=h;}} as unknown as WecomAibotConnectionManager;
    const handle=startUserNoticeApproval(manager,{onlineUserSubset:()=>[],broadcastToUsers:()=>0,sendWecom:async()=>{}});
    await handle.runNow();
    const binding=(await query<{binding_code:string}>(`SELECT binding_code FROM selfheal_notice_approver_bindings WHERE channel_id=$1`,[ch])).rows[0];
    const msg:AibotInboundMessage={channelId:ch,reqId:'bind-mentioned',chatId:'group-dx',chatType:'group',fromUserId:'dx-wecom',text:`@openclaude 绑定审批 ${binding.binding_code}`};
    assert.match(await inbound(msg) ?? "",/已绑定/);
    const active=(await query<{active:boolean;chat_id:string;chat_type:string;from_user_id:string}>(
      `SELECT active,chat_id,chat_type,from_user_id FROM selfheal_notice_approver_bindings WHERE channel_id=$1`,[ch])).rows[0];
    assert.deepEqual(active,{active:true,chat_id:'group-dx',chat_type:'group',from_user_id:'dx-wecom'});
    assert.equal(await inbound({...msg,reqId:'not-a-command',text:'@openclaude 请聊天'}),null);
    await handle.stop();
  });

  test("freezes actual online evidence, requires exact bound WeCom approval, then sends only frozen+online",async(t)=>{
    if(!available){t.skip("pg unavailable");return;}
    const s=await seed();
    let inbound:AibotInboundHandler=async()=>null;
    const wecom:string[]=[]; const sent:string[]=[]; const payloads:Record<string,unknown>[]=[];
    const manager={
      setInboundHandler(h:AibotInboundHandler|null){if(h) inbound=h;},
      async send(_id:string,md:string){wecom.push(md);},
    } as unknown as WecomAibotConnectionManager;
    const handle=startUserNoticeApproval(manager,{
      onlineUserSubset:(ids)=>ids.filter((id)=>id===s.user),
      broadcastToUsers:(ids,payload)=>{
        sent.push(...ids); payloads.push(payload as Record<string,unknown>); return ids.length;
      },
      sendWecom:async(_id,chatId,chatType,md)=>{
        assert.equal(chatId,'chat-dx'); assert.equal(chatType,'single'); wecom.push(md);
      },
    });
    await handle.runNow();
    const p=(await query<{id:string;short_code:string;status:string;recipient_count:number}>(
      `SELECT id::text,short_code,status,recipient_count FROM selfheal_user_notice_proposals WHERE repair_id=$1`,[s.rep])).rows[0];
    assert.equal(p.status,"pending"); assert.equal(p.recipient_count,1);
    assert.ok(wecom.some((x)=>x.includes(`待审批 #${p.short_code}`)));
    const wrong: AibotInboundMessage={channelId:s.ch,reqId:'cmd-wrong',chatId:'chat-dx',chatType:'single',fromUserId:'intruder',text:`同意 ${p.short_code}`};
    assert.match(await inbound(wrong) ?? "",/无权审批/);
    assert.match(await inbound({...wrong,reqId:'cmd-no-type',fromUserId:'dx-wecom',chatType:null}) ?? "",/缺少企微原始 chat_type/);
    const ok={...wrong,reqId:'cmd-ok',fromUserId:'dx-wecom',text:`@openclaude 同意 ${p.short_code}`};
    assert.match(await inbound(ok) ?? "",/已同意/);
    assert.match(await inbound(ok) ?? "",/重复回调/);
    await handle.runNow();
    assert.deepEqual(sent,[s.user]);
    assert.equal(payloads.length,1);
    assert.equal(payloads[0].type,"sys.incident");
    assert.equal(payloads[0].status,"resolved");
    assert.equal(payloads[0].noticeKind,"approved_recovery");
    assert.equal(payloads[0].incidentId,s.inc);
    const fin=(await query<{status:string;sent_recipient_count:number}>(`SELECT status,sent_recipient_count FROM selfheal_user_notice_proposals WHERE id=$1`,[p.id])).rows[0];
    assert.equal(fin.status,"sent"); assert.equal(fin.sent_recipient_count,1);
    assert.ok(wecom.some((x)=>x.includes("确认在线发送:1 人")));
    await handle.stop();
  });

  test("skips an approved notice if the condition fires again before delivery",async(t)=>{
    if(!available){t.skip("pg unavailable");return;}
    const s=await seed();
    let inbound:AibotInboundHandler=async()=>null;
    const sent:string[]=[];
    const manager={
      setInboundHandler(h:AibotInboundHandler|null){if(h) inbound=h;},
    } as unknown as WecomAibotConnectionManager;
    const handle=startUserNoticeApproval(manager,{
      onlineUserSubset:(ids)=>ids.filter((id)=>id===s.user),
      broadcastToUsers:(ids)=>{sent.push(...ids);return ids.length;},
      sendWecom:async()=>{},
    });
    await handle.runNow();
    const p=(await query<{id:string;short_code:string}>(
      `SELECT id::text,short_code FROM selfheal_user_notice_proposals WHERE repair_id=$1`,[s.rep])).rows[0];
    const decision:AibotInboundMessage={channelId:s.ch,reqId:'cmd-refire',chatId:'chat-dx',chatType:'single',fromUserId:'dx-wecom',text:`同意 ${p.short_code}`};
    assert.match(await inbound(decision) ?? "",/已同意/);
    await query(`SELECT * FROM write_alert_condition($1,'probe',TRUE,'critical','{}'::jsonb,NOW(),NULL,1)`,
      ['ops.monitor:svc_v5']);
    await handle.runNow();
    assert.deepEqual(sent,[]);
    const fin=(await query<{status:string;decision_reason:string}>(
      `SELECT status,decision_reason FROM selfheal_user_notice_proposals WHERE id=$1`,[p.id])).rows[0];
    assert.equal(fin.status,"skipped");
    assert.equal(fin.decision_reason,"recovery no longer current");
    await handle.stop();
  });
});
