import json,pathlib,datetime,collections,statistics,sys
P=pathlib.Path(sys.argv[1])
def rows(name):
 p=P/name
 return [json.loads(x)for x in p.read_text().splitlines() if x.strip()] if p.exists() else []
def epoch(ts):return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()*1000
J=json.loads((P/'billing-all.json').read_text()); events=rows('browser-events.jsonl'); web={}
for e in events:
 if e.get('event')=='sent':web[(e['sessionId'],e['clientMessageId'])]=dict(e)
for r in rows('browser-turns.jsonl'):
 web[(r['sessionId'],r['clientMessageId'])].update(r)
for p in P.glob('browser-observed-turns-*.jsonl'):
 for snap in rows(p.name):
  for r in snap.get('turns',[]):web[(r['sessionId'],r['clientMessageId'])].update(r)
for e in events:
 if e.get('event') in ('first_text_at','first_reasoning_at','final'):
  candidates=[r for r in web.values()if r['clientMessageId']==e.get('clientMessageId')]
  if len(candidates)!=1:raise ValueError('ambiguous_event')
  r=candidates[0];r['traceId']=r.get('traceId')or e.get('traceId');key='final_at'if e['event']=='final'else e['event'];r[key]=r.get(key)or e['at']
G=rows('gateway-timing.jsonl');M=rows('master-timing.jsonl');out=[]
for key,r in web.items():
 dd=[d for d in J['dispatches']if (d['session_id'],d['client_message_id'])==key]
 tt=[t for t in J['traces']if len(dd)==1 and t.get('dispatch_id')==dd[0]['dispatch_id']]
 if len(tt)==1:
  assert r.get('traceId')in(None,tt[0]['trace_id']);r['traceId']=tt[0]['trace_id']
 t=r.get('traceId');d=dd[0]if len(dd)==1 else None
 model=r.get('model')or r.get('wire_model')or(d or{}).get('model')
 usage=[u for u in J['usage']if d and (u.get('dispatch_id')==d['dispatch_id']or u.get('request_id')==d['billing_request_id'])]
 journals=[q for q in J['journals']if d and q.get('dispatch_id')==d['dispatch_id']]
 perf=[q for q in J.get('upstream_performance',[])if d and q.get('dispatch_id')==d['dispatch_id']]
 fg=[f for f in J['friction']if f.get('trace_id')==t and f.get('session_id')==r['sessionId']]
 firstframe=[f for f in fg if f['stage']=='first_text_frame'];firstthinking=[f for f in fg if f['stage']=='first_thinking_frame'];paint=[f for f in fg if f['stage']=='first_text_paint']
 mm=[x for x in M if x.get('msg')=='user-chat-bridge: inbound turn start'and x.get('traceId')==t]
 gg={x['stage']:x for x in G if x.get('msg')=='turn_pipeline_timing'and x.get('traceId')==t}
 success=bool(d and d.get('outcome')=='completed'and usage and all(u.get('status')=='success'for u in usage)and not r.get('error_code'))
 # status of CCB usage is completed/charged in some adapters: terminal dispatch is primary; exclude actual error/aborted usage.
 success=bool(d and d.get('outcome')=='completed' and not r.get('error_code') and all(u.get('status')not in('error','aborted','failed')for u in usage))
 p=r['payload_ts'];m=epoch(mm[0]['ts'])if len(mm)==1 else None
 submit=epoch(gg['gateway_to_submit']['ts'])if 'gateway_to_submit'in gg else None
 gateway=submit-gg['gateway_to_submit']['elapsedMs']if submit is not None else None
 context=submit+gg['context_ready']['elapsedMs']if submit is not None and 'context_ready'in gg else None
 mastertext=m+firstframe[0]['latency_ms']if m is not None and len(firstframe)==1 else None
 seg={}
 def delta(name,a,b):seg[name]=b-a if a is not None and b is not None else None
 delta('submit_to_master_approx_ms',p,m);delta('master_to_gateway_approx_ms',m,gateway);delta('gateway_to_submit_ms',gateway,submit)
 for name,st,prev in [('submit_lock_ms','submit_lock_acquired',None),('memory_barrier_ms','memory_barrier_acquired','submit_lock_acquired'),('context_after_barrier_ms','context_ready','memory_barrier_acquired')]:
  seg[name]=gg[st]['elapsedMs']-(gg[prev]['elapsedMs']if prev else 0)if st in gg and (not prev or prev in gg)else None
 delta('context_to_master_text_residual_approx_ms',context,mastertext if success else None)
 delta('master_text_to_browser_approx_ms',mastertext if success else None,r.get('first_text_at')if success else None)
 doms=[e for e in events if e.get('event')=='dom_first_text'and e.get('clientMessageId')==r['clientMessageId']]
 nextsend=min([s['payload_ts']for s in web.values()if s['payload_ts']>p],default=float('inf'))
 valid_dom=[];invalid_dom=[]
 for dom in doms:
  identity=(dom.get('kind')=='process'and dom.get('virtual_key')=='process:'+r['clientMessageId'])or(dom.get('kind')=='assistant'and bool(r.get('first_text_message_id'))and dom.get('virtual_key')==r['first_text_message_id'])
  rect=dom.get('rect')or{};ok=success and identity and p<=dom['at']<nextsend and dom.get('char_count',0)>0 and rect.get('width',0)>0 and rect.get('height',0)>0
  (valid_dom if ok else invalid_dom).append(dom)
 dom=min(valid_dom,key=lambda e:e['at'])if valid_dom else None
 paint_ms=paint[0]['latency_ms']if len(paint)==1 else None
 delta('browser_to_valid_dom_approx_ms',r.get('first_text_at')if success else None,dom['at']if dom else None)
 delta('submit_to_browser_text_ms',p,r.get('first_text_at')if success else None)
 row={'label':r.get('label'),'round':r.get('round'),'model':model,'sessionId':r['sessionId'],'clientMessageId':r['clientMessageId'],'traceId':t,'dispatch_id':d['dispatch_id']if d else None,'dispatch_status':d.get('status')if d else None,'dispatch_outcome':d.get('outcome')if d else None,'failure_code':d.get('failure_code')if d else None,'browser_error_code':r.get('error_code'),'success':success,'automatic_recovery':r.get('label')is None,'send_attempts':r.get('send_attempts',1),'payload_ts':p,'first_text_at':r.get('first_text_at'),'final_at':r.get('final_at'),'first_text_message_id':r.get('first_text_message_id'),'segments':seg,'master_text_latency_ms':firstframe[0]['latency_ms']if len(firstframe)==1 else None,'browser_thinking_ms':r['first_reasoning_at']-p if r.get('first_reasoning_at')and success else None,'master_thinking_latency_ms':firstthinking[0]['latency_ms']if len(firstthinking)==1 else None,'paint_probe_ms':paint_ms,'paint_probe_is_final_branch_only':True,'valid_dom_ms':dom['at']-p if dom else None,'dom':dom,'unverified_dom':invalid_dom,'runtime':tt[0]if len(tt)==1 else None,'usage_ids':[u['id']for u in usage],'credits':sum(int(u['cost_credits'])for u in usage),'input_tokens':sum(int(u['input_tokens']or 0)for u in usage),'cache_read_tokens':sum(int(u['cache_read_tokens']or 0)for u in usage),'output_tokens':sum(int(u['output_tokens']or 0)for u in usage),'journal_count':len(journals),'journal_states':dict(collections.Counter(q['state']for q in journals)),'first_journal_at':min([q['created_at']for q in journals],default=None),'context_to_first_journal_approx_ms':min([epoch(q['created_at'])for q in journals])-context if journals and context is not None else None,'upstream_performance':perf,'observer_partial':not any(x.get('clientMessageId')==r['clientMessageId']for x in rows('browser-turns.jsonl'))}
 if success:
  chain=[v for k,v in seg.items()if k not in('browser_to_valid_dom_approx_ms','submit_to_browser_text_ms')]
  row['chain_closure_ms']=sum(chain)-seg['submit_to_browser_text_ms']if all(v is not None for v in chain)and seg['submit_to_browser_text_ms']is not None else None
 out.append(row)
summary={}
for model in sorted({x['model']for x in out if x['model']}):
 group=[x for x in out if x['model']==model];summary[model]={'sent':len(group),'successful':sum(x['success']for x in group),'credits':sum(x['credits']for x in group),'first_round_ms':[x['segments']['submit_to_browser_text_ms']for x in group if x['success']and x['round']==1],'followup_ms':[x['segments']['submit_to_browser_text_ms']for x in group if x['success']and x['round']==2],'dom_ms':[x['valid_dom_ms']for x in group if x['valid_dom_ms']is not None]}
result={'rows':out,'summary':summary,'unique_transport_sends':len(out),'transport_frames':sum(x['send_attempts']for x in out),'automatic_recovery_sends':sum(x['automatic_recovery']for x in out),'chain_caveat':'cross-process timestamps approximate; residual includes runner/CLI/proxy/upstream, cannot label provider compute; paint probe final assistant branch only'}
(P/'timing-analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k!='rows'},ensure_ascii=False))
