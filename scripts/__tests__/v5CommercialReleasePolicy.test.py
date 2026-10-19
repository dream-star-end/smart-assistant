#!/usr/bin/env python3
"""Real commercial data adapter and source-bound outer blocks. No production I/O."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('commercial_policy', REPO / 'scripts/lib/v5-commercial-release-policy.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class CommercialPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ocv5-521-commercial-')
        self.root = Path(self.tmp.name)
        self.policy = self.root / 'policy'; self.policy.mkdir(mode=0o700)
        self.old = self.root / 'old'; self.new = self.root / 'new'
        for directory, sha in [(self.old, '1'*40), (self.new, '2'*40)]:
            directory.mkdir(); (directory / '.complete').write_text(json.dumps({'sourceCommit':sha}))
        self.env = self.root / 'env'; self.env.write_text('OC_RUNTIME_IMAGE=old\nOC_RUNTIME_IMAGE_ID=old-id\nOC_RUNTIME_RELEASE=/old\nOC_PLATFORM_BUNDLE=\n')
        self.platform = self.root / 'platform'; self.platform.mkdir()
        self.hist = self.root / 'history'; self.hist.write_text('')
        self.snap = self.root / 'snapshot'; self.snap.write_text(self.env.read_text())
        self.live = self.root / 'live'; self.live.symlink_to(self.old)
        self.marker = self.root / 'recovery'; self.port = self.free_port()
        self.options = dict(sha='2'*40, slot='B', port=self.port, withDist=True, restartEgress=True, egressBefore=str(self.old), egressTargetSlot='A', queueId='rq-test', bundleDigest='a'*64,
                            authority=dict(lockVersion=1, activeSlot='B', activeRelease=str(self.old), previousRelease=''))
        self.env_patch = patch.dict(os.environ, CP_DEPLOY_ID='deploy-test', CP_LANE_NONCE='nonce-test')
        self.env_patch.start()
        self.module_patch = patch.multiple(m, ROOT=self.policy, ACTIVE=self.policy/'active.json', MARKER=self.marker)
        self.module_patch.start()
        self.owner_patch = patch.object(m, 'owner', return_value=None); self.owner_patch.start()

    def tearDown(self):
        self.owner_patch.stop(); self.module_patch.stop(); self.env_patch.stop(); self.tmp.cleanup()

    def free_port(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); return sock.getsockname()[1]

    def action(self, name, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out): m.main(name, list(args))
        return out.getvalue().strip()

    def prepare(self,bundle=""):
        self.action('prepare',json.dumps(self.options),str(self.snap),'',str(self.env),str(self.platform),str(self.hist),
                    'new','new-id','/new',bundle,str(self.new),str(self.old),'joint')
        self.action('arm')
        self.live.unlink(); self.live.symlink_to(self.new)
        self.env.write_text('OC_RUNTIME_IMAGE=new\nOC_RUNTIME_IMAGE_ID=new-id\nOC_RUNTIME_RELEASE=/new\nOC_PLATFORM_BUNDLE='+bundle+'\n')

    def failure(self, authority='applied'):
        return self.action('failure','state',authority,str(self.env),str(self.platform),str(self.live),'test.service')

    def test_healthy_history_or_external_gate_failure_keeps_service(self):
        self.prepare()
        with patch.object(m,'unit_info',return_value=('active','123',str(self.new))), patch.object(m,'health',return_value=True):
            self.assertEqual(self.failure(),'KEEP_FAILED')
        self.assertEqual(self.live.resolve(), self.new)
        self.assertTrue(m.ACTIVE.exists()); self.assertTrue(self.marker.exists())
        self.assertEqual(m.context()[0]['failure']['decision'],'KEEP_FAILED')

    def test_unknown_identity_never_authorizes_compensation(self):
        self.prepare(); self.env.write_text('OC_RUNTIME_IMAGE=alien\n')
        with patch.object(m,'unit_info',return_value=('failed','0','')):
            self.assertEqual(self.failure(),'HOLD_UNKNOWN')
        self.assertTrue(m.ACTIVE.exists())

    def test_actual_failed_candidate_refused_port_allows_original_guarded_compensation(self):
        self.prepare()
        with patch.object(m,'unit_info',return_value=('failed','0','')):
            self.assertEqual(self.failure(),'COMPENSATE_USER_IMPAIRMENT')

    def test_operation_bound_attempt_can_use_fresh_alternate_slot(self):
        self.prepare()
        self.action('egress-attempt','B')
        self.assertEqual(self.action('egress-slot'),'B')
        c,d=m.context();receipt=self.policy/(c['operationId']+'.egress.json')
        receipt.write_text(json.dumps(dict(operationId='alien',slot='B')))
        with self.assertRaises(m.p.PolicyError):self.action('egress-slot')

    def test_exact_operator_evidence_can_recover_degraded_healthy_process(self):
        self.prepare()
        with patch.object(m,'unit_info',return_value=('active','123',str(self.new))),patch.object(m,'health',return_value=True):
            args=['operator','applied',str(self.env),str(self.platform),str(self.live),'test.service','a'*64]
            self.assertEqual(self.action('failure',*args),'COMPENSATE_USER_IMPAIRMENT')
            self.env.write_text('OC_RUNTIME_IMAGE=alien\n')
            self.assertEqual(self.action('failure',*args),'HOLD_UNKNOWN')

    def test_before_history_must_match_actual_frozen_tuple(self):
        self.prepare()
        row=dict(image='old',image_id='old-id',release='/old',bundle='')
        self.action('rollback-before-check',json.dumps(row))
        row['release']='/earlier-unrelated-history'
        with self.assertRaises(m.p.PolicyError):self.action('rollback-before-check',json.dumps(row))

    def test_verify_identity_allows_dead_exact_master_but_not_alien_tuple(self):
        self.prepare()
        self.action('verify-identity','target',str(self.env),str(self.platform),str(self.live))
        self.env.write_text('OC_RUNTIME_IMAGE=alien\n')
        with self.assertRaises(m.p.PolicyError):self.action('verify-identity','target',str(self.env),str(self.platform),str(self.live))

    def test_actual_policy_rollback_preserves_context_and_calls_original_guards(self):
        # Run the real controller, replacing only external facts/old publisher entrypoint.
        script=r'''set -eu
source "$1/scripts/lib/v5-commercial-release-policy.sh"
DRY=0; CP_ROOT="$2"; DEPLOY_RECOVERY_MARKER="$2/manual"; KL_HOST=fixture
V5_ENV=env; OC_HOTCFG_PLATFORM_ROOT=platform; ACTIVE_SRC=live; ACTIVE_UNIT=unit
commercial_policy_ship(){ :; }
# Dispatcher for the real shell verification function.
function commercial_policy_rmt() {
  local fn="$1"; shift
  if [[ "$fn" == commercial_policy_verified_history ]]; then echo missing; return; fi
  case "${2:-}" in
    target.masterRelease) echo new ;;
    history.path) echo history ;;
    operationId) echo op ;;
    *) case "$1" in failure) echo "${DECISION:-COMPENSATE_USER_IMPAIRMENT}" ;; verify-identity|rollback-marker) return "${IDENTITY_RC:-0}" ;; rollback-before-check) return "${N1_RC:-0}" ;; esac ;;
  esac
}
commercial_policy_authority_status(){ echo applied; }
hotcfg_rmt(){ echo '{}'; }
commercial_policy_reconcile_metadata(){ echo RECONCILE >> "$CP_ROOT/calls"; }
rollback(){
  [[ "$COMMERCIAL_FAILURE_POLICY" == '' && "$DEPLOY_RECOVERY_MARKER" == "$CP_ROOT/op.rollback-recovery" && "$ROLLBACK_N" == 1 ]]
  [[ -f "$CP_ROOT/manual" && -f "$CP_ROOT/active.json" ]]
  echo ORIGINAL_ROLLBACK >> "$CP_ROOT/calls"
}
ssh(){ shift; bash -c "$*"; }
commercial_policy_complete_compensation(){ echo FULL_OLD_GATES >> "$CP_ROOT/calls"; }
commercial_policy_rollback
'''
        self.marker.write_text('original typed evidence')
        (self.policy/'manual').write_text('original typed evidence')
        (self.policy/'active.json').write_text('original context')
        for env_add,expected,calls in [({},0,['RECONCILE','ORIGINAL_ROLLBACK','FULL_OLD_GATES']),({'DECISION':'KEEP_FAILED'},79,[]),({'IDENTITY_RC':'86'},86,[]),({'N1_RC':'79'},79,[])]:
            journal=self.policy/'calls'
            if journal.exists():journal.unlink()
            env=os.environ.copy();env.update(env_add)
            result=subprocess.run(['bash','-s','--',str(REPO),str(self.policy)],input=script,text=True,capture_output=True,env=env)
            self.assertEqual(result.returncode,expected,result.stdout+result.stderr)
            self.assertEqual(journal.read_text().splitlines() if journal.exists() else [],calls)
            self.assertEqual((self.policy/'manual').read_text(),'original typed evidence')

    def test_disabled_predecessor_current_has_exact_repair_plan(self):
        bundle=self.platform/'bundles/new';bundle.mkdir(parents=True)
        self.prepare(str(bundle))
        self.live.unlink();self.live.symlink_to(self.old)
        self.env.write_text(self.snap.read_text())
        current=self.platform/'current';current.symlink_to('bundles/new')
        with patch.object(m,'unit_info',return_value=('active','123',str(self.old))),patch.object(m,'health',return_value=True):
            plan=self.action('before-current-plan',str(self.env),str(self.platform),str(self.live),'unit')
            self.assertEqual(json.loads(plan),dict(needed=True,target=''))
            current.unlink();current.symlink_to('bundles/unrelated')
            with self.assertRaises(m.p.PolicyError):self.action('before-current-plan',str(self.env),str(self.platform),str(self.live),'unit')
            current.unlink();current.symlink_to('bundles/new')
        planfile=self.root/'verified-plan';planfile.write_text(plan)
        script='''set -eu
source "$1/scripts/v5-runtime-release-lib.sh"
source "$1/scripts/lib/v5-commercial-release-policy.sh"
OC_HOTCFG_PLATFORM_ROOT="$2"; OC_HOTCFG_ENV_FILE=env; CP_LIVE=live; CP_UNIT=unit
commercial_policy_remote_owner(){ :; }
commercial_policy_py(){ cat "$PLANFILE"; }
commercial_policy_restore_disabled_current
'''
        env=os.environ.copy();env['PLANFILE']=str(planfile)
        result=subprocess.run(['bash','-s','--',str(REPO),str(self.platform)],input=script,text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertFalse(current.is_symlink())
        self.assertEqual(m.stack(self.live,self.env,self.platform,'B',self.port),m.context()[0]['before'])

    def test_source_binding_uses_frozen_direction_without_head_fallback(self):
        self.prepare()
        self.assertEqual(self.action('source-for-release',str(self.new)),'2'*40)
        self.assertEqual(self.action('source-for-release',str(self.old)),'1'*40)
        with self.assertRaises(m.p.PolicyError):self.action('source-for-release','/another/release')

    def test_health_observer_uses_actual_commercial_deps_schema(self):
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        from threading import Thread
        response=dict(ok=True,channel='v5',deps=dict(sessionsDb='ok',pg='ok',redis='ok'))
        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner):
                inner.send_response(200);inner.end_headers();inner.wfile.write(json.dumps(response).encode())
            def log_message(inner,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            self.assertTrue(m.health(server.server_port))
            response['deps']['sessionsDb']='unavailable';response['sessionsDb']='ok'
            self.assertFalse(m.health(server.server_port))
        finally:server.shutdown();thread.join();server.server_close()

    def test_actual_automatic_saga_compensation_closes_original_lineage(self):
        script=r'''set -eu
source "$1/scripts/lib/v5-commercial-release-policy.sh"
CP_ROOT="$2"; KL_HOST=fixture; V5_ENV=env; OC_HOTCFG_PLATFORM_ROOT=platform; ACTIVE_SRC=live; ACTIVE_UNIT=unit
commercial_policy_authority_status(){
  if [[ "$STATE" == original ]]; then echo original
  elif [[ "${1:-}" == before && "$STATE" == reverted ]]; then echo applied
  else echo unknown; fi
}
commercial_policy_rmt(){
  local fn="$1"; shift
  case "$fn" in
    commercial_policy_verified_history) echo missing ;;
    commercial_policy_compensated_history) echo VERIFIED_REVERSE_HISTORY >> "$CP_ROOT/calls" ;;
    commercial_policy_restore_disabled_current) : ;;
    commercial_policy_py) case "$1" in
      field) case "$2" in before.masterRelease) echo old ;; target.masterRelease) echo new ;; options.restartEgress) echo false ;; operationId) echo op ;; esac ;;
      verify) : ;;
      archive-direction) echo '' ;;
      resolve) printf 'RESOLVE %s %s\n' "$2" "$3" >> "$CP_ROOT/calls" ;;
      *) return 79 ;;
    esac ;;
    *) return 79 ;;
  esac
}
ssh(){ shift; bash -c "$*"; }
commercial_policy_required_gates(){ echo "ALL_OLD_GATES $1" >> "$CP_ROOT/calls"; }
commercial_policy_complete_compensation
'''
        for state,expected in [('original',['ALL_OLD_GATES old','RESOLVE before original']),('reverted',['VERIFIED_REVERSE_HISTORY','ALL_OLD_GATES old','RESOLVE before reverted'])]:
            journal=self.policy/'calls'
            if journal.exists():journal.unlink()
            env=os.environ.copy();env['STATE']=state
            result=subprocess.run(['bash','-s','--',str(REPO),str(self.policy)],input=script,text=True,capture_output=True,env=env)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertEqual(journal.read_text().splitlines(),expected)

    def test_actual_forward_retry_failure_restores_service_and_keeps_failed_context(self):
        script=r'''set -eu
source "$1/scripts/lib/v5-commercial-release-policy.sh"
CP_ROOT="$2"; EGRESS_SLOT_PREDRAIN_SEC=0
commercial_policy_rmt(){
  case "$1" in
    commercial_policy_py) echo old ;;
    commercial_policy_reverse_unavailable) echo PROVED_OUTAGE >> "$CP_ROOT/calls" ;;
    *) return 79 ;;
  esac
}
egress_slots_remote(){
  case "$1" in
    policy-state) echo unavailable ;;
    restore) echo FORWARD_FREE_SLOT >> "$CP_ROOT/calls"; return "$FAULT" ;;
    converge) echo UNEXPECTED_ACCEPT >> "$CP_ROOT/calls" ;;
  esac
}
commercial_policy_reverse_dead_egress(){ echo "RESTORE_OLD $1" >> "$CP_ROOT/calls"; }
commercial_policy_resume_egress new
'''
        for fault,code,expected in [('1',78,['FORWARD_FREE_SLOT','PROVED_OUTAGE','RESTORE_OLD old']),('86',86,['FORWARD_FREE_SLOT'])]:
            journal=self.policy/'calls'
            if journal.exists():journal.unlink()
            env=os.environ.copy();env['FAULT']=fault
            result=subprocess.run(['bash','-s','--',str(REPO),str(self.policy)],input=script,text=True,capture_output=True,env=env)
            self.assertEqual(result.returncode,code,result.stdout+result.stderr)
            self.assertEqual(journal.read_text().splitlines(),expected)

    def test_unknown_authority_is_not_a_rollback_trigger(self):
        self.prepare()
        with patch.object(m,'unit_info',return_value=('active','123',str(self.new))), patch.object(m,'health',return_value=True):
            self.assertEqual(self.failure('unknown'),'HOLD_UNKNOWN')

    def test_exact_descriptor_rejects_same_sha_or_options_tampering(self):
        self.prepare(); c,d=m.context(); path=self.policy/(c['operationId']+'.json')
        d['options']['withDist']=False; path.write_text(json.dumps(d))
        with self.assertRaises(m.p.PolicyError):m.context()

    def test_history_prefix_and_target_are_exact(self):
        self.prepare(); self.assertEqual(self.action('history-status'),'missing')
        c,d=m.context();t=c['target']['tuple']
        row=dict(image=t['OC_RUNTIME_IMAGE'],image_id=t['OC_RUNTIME_IMAGE_ID'],release=t['OC_RUNTIME_RELEASE'],bundle=t['OC_PLATFORM_BUNDLE'],masterRelease=str(self.new),previousMasterRelease=str(self.old),transitionKind='joint')
        self.hist.write_text(json.dumps(row)+'\n');self.assertEqual(self.action('history-status'),'applied')
        row['masterRelease']=str(self.old);self.hist.write_text(json.dumps(row)+'\n')
        with self.assertRaises(m.p.PolicyError):self.action('history-status')

    @contextlib.contextmanager
    def actual_owner_environment(self):
        import time
        lock=self.root/'history-mutation.lock';pidfile=self.root/'history-holder.pid'
        holder=subprocess.Popen(['bash','-c','exec 9>"$1"; flock 9; printf "%s" "$$" >"$2"; read -r _','holder',str(lock),str(pidfile)],stdin=subprocess.PIPE)
        try:
            deadline=time.monotonic()+5
            while not pidfile.exists() and time.monotonic()<deadline:time.sleep(.01)
            pid=int(pidfile.read_text())
            Path(str(lock)+'.meta').write_text(json.dumps(dict(deploy_id='history-holder',remote_pid=pid,started_at=int(time.time()),ttl=60)))
            Path(str(lock)+'.admission-nonce').write_text('history-admission'+chr(10))
            lane=self.root/'history-lane';lane.write_text(json.dumps(dict(nonce='history-lane')))
            env=os.environ.copy();env.update(CP_ROOT=str(self.policy),CP_BUNDLE=str(REPO/'scripts'),CP_LOCK=str(lock),CP_DEPLOY_ID='history-holder',CP_ADMISSION='history-admission',CP_LANE_MARKER=str(lane),CP_LANE_NONCE='history-lane')
            yield env
        finally:
            holder.stdin.close();holder.wait(timeout=5)

    def test_real_history_checksum_rejects_forged_target_tail(self):
        self.prepare();c,d=m.context();t=c['target']['tuple']
        row=dict(schemaVer=3,seq=1,ts='2026-10-19T00:00:00Z',checksum='0'*64,image=t['OC_RUNTIME_IMAGE'],image_id=t['OC_RUNTIME_IMAGE_ID'],release=t['OC_RUNTIME_RELEASE'],bundle=t['OC_PLATFORM_BUNDLE'],masterRelease=str(self.new),previousMasterRelease=str(self.old),transitionKind='joint')
        self.hist.write_text(json.dumps(row)+'\n')
        script='''set -eu
source "$1/scripts/v5-runtime-release-lib.sh"
source "$1/scripts/lib/v5-commercial-release-policy.sh"
commercial_policy_remote_owner(){ :; }
commercial_policy_verified_history
'''
        env=os.environ.copy();env.update(CP_ROOT=str(self.policy),CP_BUNDLE=str(REPO/'scripts'))
        with self.actual_owner_environment() as env:
            result=subprocess.run(['bash','-s','--',str(REPO)],input=script,text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,79,result.stdout+result.stderr)

    def test_real_history_accepts_exact_next_sequence_after_predecessor(self):
        seed='source "$1/scripts/v5-runtime-release-lib.sh"; oc_hotcfg_history_append "$2" old old-id /old "" "$3" prestate prestate ""'
        result=subprocess.run(['bash','-c',seed,'seed',str(REPO),str(self.hist),str(self.old)],text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.prepare()
        append='source "$1/scripts/v5-runtime-release-lib.sh"; oc_hotcfg_history_append "$2" new new-id /new "" "$3" "" joint "$4"'
        result=subprocess.run(['bash','-c',append,'append',str(REPO),str(self.hist),str(self.new),str(self.old)],text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        script='source "$1/scripts/v5-runtime-release-lib.sh"; source "$1/scripts/lib/v5-commercial-release-policy.sh"; commercial_policy_verified_history'
        with self.actual_owner_environment() as env:
            result=subprocess.run(['bash','-c',script,'verify',str(REPO)],text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(result.stdout.strip(),'applied')

    def test_owner_loss_inside_prepare_is_fence_error(self):
        with patch.object(m,'assert_owner',side_effect=m.p.PolicyError('lost')):
            self.owner_patch.stop()
            with self.assertRaises(m.FenceError):m.owner()
            self.owner_patch.start()

    def test_exact_archive_cleanup_does_not_repeat_gates(self):
        self.prepare();c,d=m.context()
        with patch.object(m,'unit_info',return_value=('active','123',str(self.new))),patch.object(m,'health',return_value=True),patch.object(m,'clear_marker',side_effect=OSError('unlink ACK')):
            with self.assertRaises(OSError):self.action('resolve','target','applied',str(self.env),str(self.platform),str(self.live),'test.service')
        self.assertFalse(m.ACTIVE.exists());self.assertTrue(self.marker.exists())
        self.assertEqual(self.action('archived'),'true')
        with patch.object(m,'unit_info',return_value=('active','123',str(self.new))),patch.object(m,'health',return_value=True):
            self.action('clear-accepted-marker',str(self.env),str(self.platform),str(self.live),'test.service')
        self.assertFalse(self.marker.exists())

    def test_actual_outer_propagates_typed_saga_rc_without_old_plugin_reopen(self):
        source=(REPO/'scripts/deploy-v5.sh').read_text()
        begin=source.index('  if [[ "$hc_any" == 1 ]]; then\n    if activate_runtime_tuple;')
        end=source.index('  local egress_switched=',begin)
        block=source[begin:end]
        for rc in [78,79,86]:
            script='''set -eu
hc_any=1
activate_runtime_tuple(){ return RC; }
commercial_policy_keep_failed(){ return \"$1\"; }
require_mutation_lease_for_compensation(){ echo UNEXPECTED_OLD_PLUGIN; return 0; }
'''.replace('RC',str(rc))+'\nactual_outer(){\n'+block+'\n}\nactual_outer\n'
            result=subprocess.run(['bash','-s'],input=script,text=True,capture_output=True)
            self.assertEqual(result.returncode,rc,result.stdout+result.stderr)
            self.assertNotIn('UNEXPECTED_OLD_PLUGIN',result.stdout)

    def test_actual_outer_validation_does_not_enter_legacy_compensation(self):
        source=(REPO/'scripts/deploy-v5.sh').read_text();begin=source.index('  if [[ -n "$validation_failure" ]]; then\n    commercial_policy_failure')
        end=source.index('  if [[ "$DEFER_KNOWLEDGE_PLANET_UPGRADE" == 1 ]]; then\n    echo "  ✓ setup-first',begin)
        block=source[begin:end]
        for rc in [78,79,86]:
            script='''set -eu
validation_failure='external G1/cache/metadata failure'
commercial_policy_failure(){ return RC; }
require_mutation_lease_for_compensation(){ echo UNEXPECTED_ROLLBACK; return 0; }
'''.replace('RC',str(rc))+'\nactual_outer(){\n'+block+'\n}\nactual_outer\n'
            result=subprocess.run(['bash','-s'],input=script,text=True,capture_output=True)
            self.assertEqual(result.returncode,rc,result.stdout+result.stderr)
            self.assertNotIn('UNEXPECTED_ROLLBACK',result.stdout)


    def test_real_holder_flock_nonce_and_marker_fence(self):
        self.owner_patch.stop()
        lock=self.root/'mutation.lock'; pidfile=self.root/'holder.pid'
        command='exec 9>"$1"; flock 9; printf "%s" "$$" >"$2"; read -r _'
        holder=subprocess.Popen(['bash','-c',command,'holder',str(lock),str(pidfile)],stdin=subprocess.PIPE)
        try:
            import time
            deadline=time.monotonic()+5
            while not pidfile.exists() and time.monotonic()<deadline:time.sleep(.01)
            pid=int(pidfile.read_text())
            Path(str(lock)+'.meta').write_text(json.dumps(dict(deploy_id='actual-holder',remote_pid=pid,started_at=int(time.time()),ttl=60)))
            Path(str(lock)+'.admission-nonce').write_text('actual-admission' + chr(10))
            marker=self.root/'lane';marker.write_text(json.dumps(dict(nonce='actual-lane')))
            with patch.dict(os.environ,CP_LOCK=str(lock),CP_DEPLOY_ID='actual-holder',CP_ADMISSION='actual-admission',CP_LANE_MARKER=str(marker),CP_LANE_NONCE='actual-lane'):
                m.owner()
                marker.write_text(json.dumps(dict(nonce='alien-lane')))
                with self.assertRaises(m.FenceError):m.owner()
        finally:
            holder.stdin.close();holder.wait(timeout=5);self.owner_patch.start()

    def test_actual_shipping_verifies_complete_content_addressed_closure(self):
        script=r'''set -euo pipefail
source "$1/scripts/lib/v5-commercial-release-policy.sh"
SCRIPT_DIR="$1/scripts"; RUNTIME_LIB="$SCRIPT_DIR/v5-runtime-release-lib.sh"
DRY=0; MUTATION_LEASE_BYPASSED=0; COMMERCIAL_FAILURE_POLICY=user-impact-only
CP_ROOT="$2"; KL_HOST=fixture
assert_mutation_lease_alive(){ return 0; }
ssh(){ shift; bash -c "$*"; }
commercial_policy_ship
for f in v5-runtime-release-lib.sh v5-egress-slots.sh lib/v5-commercial-release-policy.sh lib/v5-commercial-release-policy.py lib/v5-release-policy.py; do
  cmp "$SCRIPT_DIR/$f" "$CP_BUNDLE/$f"
done
commercial_policy_ship
printf 'CLOSURE_OK\n'
'''
        result=subprocess.run(['bash','-s','--',str(REPO),str(self.root/'closure')],input=script,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('CLOSURE_OK',result.stdout)

if __name__=='__main__':unittest.main(verbosity=2)
