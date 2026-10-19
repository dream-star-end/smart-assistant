#!/usr/bin/env python3
"""Execute the real slot controller with isolated systemd/network facts and real process cwd."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
REPO=Path(__file__).resolve().parents[2]

class ExactEgressRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='ocv5-521-egress-')
        self.root=Path(self.tmp.name)
        self.old=self.root/'old';self.old.mkdir()
        self.new=self.root/'new';self.new.mkdir()

    def tearDown(self):self.tmp.cleanup()

    def egress_world(self, *, sticky=False, unhealthy=False, lose_owner=False, alien=False, restore=False, interrupted=False, fail_new=False, policy_restore=False):
        world=self.root/'egress';world.mkdir()
        bindir=world/'bin';bindir.mkdir()
        children=[]
        for directory in [self.old,self.old if restore else self.new]:children.append(subprocess.Popen(['sleep','90'],cwd=directory))
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(64)
        port=listener.getsockname()[1]
        pointer=world/'pointer';pointer.symlink_to(self.old if interrupted or restore else self.new)
        db=world/'world.json'
        db.write_text(json.dumps(dict(states={'A':'deactivating' if restore or policy_restore else 'active','B':'failed' if restore or policy_restore or fail_new else 'active'},sockets={'A':False if restore or policy_restore else True,'B':False if restore or policy_restore or fail_new else True},pids={'A':children[0].pid,'B':children[1].pid},sticky=sticky,unhealthy=unhealthy,lose_owner=lose_owner,fail_new=fail_new,enabled={'openclaude-v5-egress@A.service':True,'openclaude-v5-egress@A.socket':True},log=[])))
        backend=r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
f=Path(os.environ['EGRESS_WORLD']);d=json.loads(f.read_text());cmd=Path(sys.argv[0]).name;a=sys.argv[1:]
if cmd=='systemctl':
    d['log'].append(' '.join(a));f.write_text(json.dumps(d))
    slots=[x.split('@')[1].split('.')[0] for x in a if '@' in x]
    s=slots[0] if slots else ''
    if a[0]=='is-active':
        v=d['states'][s] if s and a[1].endswith('.service') else ('active' if s and d['sockets'][s] else 'inactive')
        print(v);sys.exit(0 if v=='active' else 3)
    if a[0]=='is-enabled':
        ok=d['enabled'].get(a[1],False);print('enabled' if ok else 'disabled');sys.exit(0 if ok else 1)
    if a[0] in ['enable','disable']:
        for u in a[1:]:d['enabled'][u]=a[0]=='enable'
    if a[0]=='show':
        prop=a[a.index('-p')+1]
        if prop=='MainPID':print(d['pids'][s] if d['states'][s] in ['active','deactivating'] else 0)
        elif prop=='InvocationID':print(('a' if s=='A' else 'b')*32)
        elif prop=='ActiveEnterTimestampMonotonic':print(999 if s=='A' else 1)
    elif a[0]=='stop':
        if any(x.endswith('.socket') for x in a):d['sockets'][s]=False
        else:d['states'][s]='deactivating' if '--no-block' in a else 'inactive'
    elif a[0]=='start':
        if d['fail_new'] and s=='B' and any(x.endswith('.service') for x in a):sys.exit(1)
        if any(x.endswith('.socket') for x in a):d['sockets'][s]=True
        else:d['states'][s]='active'
    f.write_text(json.dumps(d))
elif cmd=='curl':
    if d['lose_owner']:f.with_name('lost').touch()
    s='A' if '18898' in ' '.join(a) else 'B'
    if d['unhealthy']:sys.exit(7)
    print(json.dumps(dict(ok=True,slot=s,listenMode='sd_activation')))
elif cmd=='ss':
    for s in ['A','B']:
        if d['sockets'][s] or (s=='A' and d['sticky']):
            print('LISTEN 0 511 127.0.0.1:1 0.0.0.0:* users:(("node",pid='+str(d['pids'][s])+',fd=3),("systemd",pid=1,fd=4))')
elif cmd=='sysctl':print('1')
elif cmd=='sleep':pass
'''
        for name in ['systemctl','curl','ss','sysctl','sleep']:
            q=bindir/name;q.write_text(backend);q.chmod(0o755)
        # Shell curl/sleep preserve the actual 90-iteration retry loop without Python startup per tick.
        (bindir/'sleep').write_text('#!/bin/sh\nexit 0\n')
        curl='#!/bin/sh\n'
        if lose_owner:curl+=': > "${EGRESS_WORLD%/*}/lost"\n'
        if unhealthy:curl+='exit 7\n'
        else:curl+='case "$*" in *18898*) s=A ;; *) s=B ;; esac\nprintf \'{"ok":true,"slot":"%s","listenMode":"sd_activation"}\\n\' "$s"\n'
        (bindir/'curl').write_text(curl)
        if alien:
            children[0].terminate();children[0].wait();children[0]=subprocess.Popen(['sleep','90'],cwd=self.root)
            data=json.loads(db.read_text());data['pids']['A']=children[0].pid;db.write_text(json.dumps(data))
        bundle=world/'bundle';(bundle/'lib').mkdir(parents=True)
        (bundle/'lib/v5-commercial-release-policy.sh').write_text('''source "$EGRESS_ADAPTER"
commercial_policy_remote_owner(){ [[ ! -f "${EGRESS_WORLD%/*}/lost" ]] || return 86; }
commercial_policy_port_refused(){ return 0; } # controlled unavailable shared-port fact
commercial_policy_py(){
  case "$1" in
    field) [[ "$2" == options.egressBefore ]] || return 79; printf '%s\\n' "$EGRESS_OLD" ;;
    egress-attempt) printf '%s\\n' "$2" > "${EGRESS_WORLD%/*}/attempt" ;;
    egress-slot) cat "${EGRESS_WORLD%/*}/attempt" ;;
    *) return 79 ;;
  esac
}
''')
        etc=world/'etc';etc.mkdir()
        for suffix in ['service','socket']:(etc/('openclaude-v5-egress@.'+suffix)).touch()
        source=(REPO/'scripts/v5-egress-slots.sh').read_text().replace('/opt/openclaude/openclaude-v5-egress',str(pointer)).replace('/etc/systemd/system/',str(etc)+'/')
        actual=world/'actual-slots.sh';actual.write_text(source)
        env=os.environ.copy();env.update(PATH=str(bindir)+':'+env['PATH'],CP_EGRESS_POLICY='0' if restore else '1',CP_BUNDLE=str(bundle),EGRESS_WORLD=str(db),EGRESS_ADAPTER=str(REPO/'scripts/lib/v5-commercial-release-policy.sh'),EGRESS_OLD=str(self.old),OC_EGRESS_SLOTS_BIND='127.0.0.1',OC_EGRESS_SLOTS_PORT=str(port))
        args=['restore','0'] if restore or policy_restore else ['flip','0'] if fail_new else ['stabilize-before-reverse' if interrupted else 'converge',str(self.new),str(self.old)]
        try:
            result=subprocess.run(['bash',str(actual),*args],capture_output=True,text=True,env=env,timeout=20)
            return result,json.loads(db.read_text())
        finally:
            listener.close()
            for child in children:child.terminate();child.wait()

    def test_both_active_converge_ignores_mtime_drains_only_old(self):
        result,world=self.egress_world()
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        log=world['log'];close=log.index('stop --job-mode=ignore-dependencies openclaude-v5-egress@A.socket');drain=log.index('stop --no-block openclaude-v5-egress@A.service')
        self.assertLess(close,drain);self.assertEqual(world['states']['A'],'deactivating');self.assertTrue(world['sockets']['B'])
        self.assertNotIn('ActiveEnterTimestampMonotonic',' '.join(log))
        self.assertTrue(world['enabled'].get('openclaude-v5-egress@B.service'));self.assertTrue(world['enabled'].get('openclaude-v5-egress@B.socket'))
        self.assertFalse(world['enabled'].get('openclaude-v5-egress@A.service'))

    def test_old_node_listener_is_not_no_orphan_success(self):
        result,world=self.egress_world(sticky=True)
        self.assertEqual(result.returncode,79,result.stdout+result.stderr)

    def test_unknown_private_health_keeps_old_listener(self):
        result,world=self.egress_world(unhealthy=True)
        self.assertEqual(result.returncode,79,result.stdout+result.stderr);self.assertTrue(world['sockets']['A'])

    def test_foreign_process_is_never_closed(self):
        result,world=self.egress_world(alien=True)
        self.assertEqual(result.returncode,79,result.stdout+result.stderr);self.assertTrue(world['sockets']['A'])

    def test_owner_loss_after_health_crash_stops_before_close(self):
        result,world=self.egress_world(lose_owner=True)
        self.assertEqual(result.returncode,86,result.stdout+result.stderr);self.assertTrue(world['sockets']['A'])

    def test_outage_restore_uses_failed_free_slot_and_preserves_old_drain(self):
        result,world=self.egress_world(restore=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('start openclaude-v5-egress@B.service',world['log']);self.assertNotIn('start openclaude-v5-egress@A.service',world['log'])
        self.assertNotIn('still draining',result.stderr);self.assertEqual(world['states']['A'],'deactivating')

    def test_reverse_can_resume_after_pointer_rename_before_flip(self):
        result,world=self.egress_world(interrupted=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertTrue(world['sockets']['B']);self.assertFalse(world['sockets']['A'])
        self.assertEqual((self.root/'egress/pointer').resolve(),self.old)

    def test_failed_new_service_closes_its_socket_without_stopping_old(self):
        result,world=self.egress_world(fail_new=True)
        self.assertEqual(result.returncode,1,result.stdout+result.stderr)
        self.assertFalse(world['sockets']['B']);self.assertTrue(world['sockets']['A'])
        self.assertEqual(world['states']['A'],'active')

    def test_policy_forward_after_outage_uses_free_failed_slot(self):
        result,world=self.egress_world(policy_restore=True)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn('start openclaude-v5-egress@B.service',world['log'])
        self.assertNotIn('still draining',result.stderr)
        self.assertEqual(world['states']['A'],'deactivating')

if __name__=='__main__':unittest.main()
