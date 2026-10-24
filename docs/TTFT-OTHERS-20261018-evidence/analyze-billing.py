"""Exact-decimal reconciliation of selected product usage, not supplier cash."""
import pathlib,json,collections
from decimal import Decimal,ROUND_CEILING
D=pathlib.Path(__file__).parent;j=json.loads((D/'billing-all.json').read_text())
N=lambda x:int(x)if x is not None else None
byreq=collections.defaultdict(list);byusage=collections.defaultdict(list)
for r in j['journals']:byreq[r['request_id']].append(r)
for r in j['ledger']:byusage[r['ref_id']].append(r)
result=[]
for u in j['usage']:
 p=u['price'];rates=['input_per_mtok','output_per_mtok','cache_read_per_mtok','cache_write_per_mtok'];tokens=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens']
 complete=all(p.get(k)is not None for k in rates+['multiplier'])and all(u.get(k)is not None for k in tokens)
 expected=int((sum(Decimal(str(u[t]))*Decimal(str(p[r]))for t,r in zip(tokens,rates))*Decimal(str(p['multiplier']))/Decimal(1000000)).to_integral_value(rounding=ROUND_CEILING))if complete else None
 ll=byusage[u['id']];debit=sum(-N(l['delta'])for l in ll if N(l['delta'])<0 and l['reason']in('chat','agent_chat'));refund=sum(N(l['delta'])for l in ll if N(l['delta'])>0 and l['reason']=='refund')
 jj=byreq[u['request_id']];cost=N(u['cost_credits']);clamped=any(l.get('clamped')for l in ll)
 row={'id':u['id'],'scope':u['scope'],'request_id':u['request_id'],'model':u['model'],'status':u['status'],'expected_raw':expected,'usage_raw':cost,'debit_raw':debit,'refund_raw':refund,'net_raw':debit-refund,'waived':p.get('waived'),'wouldHaveCharged':p.get('wouldHaveCharged'),'verification_run_id':u.get('verification_run_id'),'clamped':clamped,'journal_count':len(jj),'journal_states':[q['state']for q in jj],'journal_raw':[N(q['final_credits'])for q in jj],'ledger_buckets':sorted({l['bucket']for l in ll})}
 row['primary_ledger_valid']=cost==0 or(clamped and debit==0 and u.get('ledger_id')is None)or any(str(l['id'])==str(u.get('ledger_id'))and N(l['delta'])<0 and l['reason']in('chat','agent_chat')for l in ll)
 row['journal_matches']=len(jj)==1 and jj[0]['state']=='committed' and N(jj[0]['final_credits'])==cost and str(jj[0].get('usage_id'))==u['id'] and str(jj[0].get('ledger_id'))==str(u.get('ledger_id'))
 if str(u['model']).startswith('antigravity-'):
  aa=[a for a in j.get('antigravity_turns',[])if a['request_id']==u['request_id']]
  relay=[a for a in j.get('antigravity_relay_usage',[])if a['request_id']==u['request_id']]
  total={'input_tokens':sum(int(a['prompt_tokens']or 0)-int(a['cached_tokens']or 0)for a in relay),'cache_read_tokens':sum(int(a['cached_tokens']or 0)for a in relay),'output_tokens':sum(int(a['candidates_tokens']or 0)+int(a['thoughts_tokens']or 0)for a in relay)}
  row['settlement_path']='antigravity_turns'
  row['antigravity_turn_count']=len(aa);row['antigravity_relay_count']=len(relay);row['antigravity_relay_totals']=total
  row['antigravity_tokens_match']=all(N(u[k])==v for k,v in total.items())
  row['journal_matches']=len(jj)==0 and len(aa)==1 and aa[0]['status']=='settled'and aa[0]['engine_status']=='success'and row['antigravity_tokens_match']
 else:row['settlement_path']='request_finalize_journal'
 row['gross_matches']=debit==cost
 row['formula_matches']=expected==cost
 if p.get('waived'):row['formula_result']='exception_requires_individual_review'
 else:row['formula_result']='PASS'if row['formula_matches']else'FAIL'
 row['three_way_result']='PASS'if row['journal_matches']and row['gross_matches']and row['primary_ledger_valid']else 'exception_requires_individual_review'if clamped and row['journal_matches']and debit<cost and row['primary_ledger_valid']else'FAIL'
 result.append(row)
scopes=collections.defaultdict(list)
for r in result:scopes[r['scope']].append(r)
summary={scope:{'usage_rows':len(rr),'expected_raw':sum(r['expected_raw']for r in rr)if all(r['expected_raw']is not None for r in rr)else None,'usage_raw':sum(r['usage_raw']for r in rr),'debit_raw':sum(r['debit_raw']for r in rr),'refund_raw':sum(r['refund_raw']for r in rr),'net_raw':sum(r['net_raw']for r in rr),'three_way_failures':[r['id']for r in rr if r['three_way_result']=='FAIL'],'formula_failures':[r['id']for r in rr if r['formula_result']=='FAIL'],'exception_ids':[r['id']for r in rr if r['formula_result']=='exception_requires_individual_review'or r['three_way_result']=='exception_requires_individual_review']}for scope,rr in scopes.items()}
missing=[]
for d in j['dispatches']:
 if d['scope']=='other_canary_account_activity':continue
 uu=[u for u in j['usage']if u.get('dispatch_id')==d['dispatch_id']or u.get('request_id')==d['billing_request_id']]
 if len(uu)!=1:missing.append({'dispatch_id':d['dispatch_id'],'request_id':d['billing_request_id'],'scope':d['scope'],'status':d['status'],'outcome':d['outcome'],'usage_rows':len(uu)})
attempt_coverage=[]
for a in j['attempts']:
 dd=[d for d in j['dispatches']if d['session_id']==a['sessionId']and d['client_message_id']==a['clientMessageId']]
 attempt_coverage.append({'sessionId':a['sessionId'],'clientMessageId':a['clientMessageId'],'dispatch_count':len(dd),'dispatch_ids':[d['dispatch_id']for d in dd]})
 if not dd:missing.append({'sessionId':a['sessionId'],'clientMessageId':a['clientMessageId'],'scope':'ordinary_web','issue':'browser_attempt_without_dispatch'})
unsettled=[{'request_id':q['request_id'],'dispatch_id':q['dispatch_id'],'scope':q['scope'],'state':q['state'],'precheck_credits':q['precheck_credits'],'final_credits':q['final_credits']}for q in j['journals']if q['scope']!='other_canary_account_activity'and q['state']not in ('committed','aborted')]
all_unsettled=[{'request_id':q['request_id'],'dispatch_id':q['dispatch_id'],'scope':q['scope'],'state':q['state'],'precheck_credits':q['precheck_credits'],'final_credits':q['final_credits']}for q in j['journals']if q['state']not in ('committed','aborted')]
output={'all_unsettled_window_journals':all_unsettled,'unsettled_selected_journals':unsettled,'attempt_coverage':attempt_coverage,'rows':result,'summary':summary,'dispatch_usage_exceptions':missing,'ledger_scope':'all usage_record buckets; refunds separate','units':'raw product unit = user points; admin CNY = raw/100; supplier cash not verified'}
(D/'billing-analysis.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'all_unsettled_window_journals':all_unsettled,'unsettled_selected_journals':unsettled,'summary':summary,'dispatch_usage_exceptions':missing},ensure_ascii=False))
