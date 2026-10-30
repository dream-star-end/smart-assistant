#!/usr/bin/env python3
"""Production worker/SQLite/classifier with private git, inbox and prepared fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('retry_classifier', SCRIPTS/'lib/v5-selfhost-train-retry.py')
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)


class Retry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='selfhost-retry-')
        cls.root = Path(cls.temp.name)
        cls.repo = cls.root/'repo'
        subprocess.run(['git','init','-q','-b','fixture',str(cls.repo)],check=True)
        for key,value in [('user.name','fixture'),('user.email','fixture@example.test')]:
            subprocess.run(['git','-C',str(cls.repo),'config',key,value],check=True)
        for i in range(2):
            (cls.repo/'file').write_text(str(i))
            subprocess.run(['git','-C',str(cls.repo),'add','.'],check=True)
            subprocess.run(['git','-C',str(cls.repo),'commit','-qm',str(i)],check=True)
            sha=subprocess.check_output(['git','-C',str(cls.repo),'rev-parse','HEAD'],text=True).strip()
            if i == 0: cls.before=sha
            else: cls.sha=sha
        cls.origin=cls.root/'origin.git'
        subprocess.run(['git','clone','-q','--bare',str(cls.repo),str(cls.origin)],check=True)
        subprocess.run(['git','-C',str(cls.repo),'remote','add','origin',str(cls.origin)],check=True)
        subprocess.run(['git','-C',str(cls.repo),'fetch','-q','origin'],check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.case=Path(tempfile.mkdtemp(dir=self.root))
        self.db=self.case/'lease.db'
        self.env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        self.env.pop('__OC_LEASE_LIB_LOADED',None)
        self.env.pop('INVOCATION_ID',None)
        self.env.update(OC_V5_LEASE_DB=str(self.db),OC_V5_LEASE_LOCK=str(self.case/'db.lock'),
            OC_V5_LEASE_REPO_ROOT=str(self.repo),OC_V5_LEASE_BRANCH='fixture',
            OC_V5_LEASE_WORKER_LOCK=str(self.case/'worker.lock'),OC_V5_SELFHOST_DEPLOY_LOCK=str(self.case/'deploy.lock'),
            OC_V5_LEASE_LOG_DIR=str(self.case),OC_V5_LEASE_LIVE_LINK=str(self.case/'live'),
            OC_V5_LEASE_SURVIVOR_STATE=str(self.case/'survivor'),OC_V5_LEASE_SURVIVOR_COMMITTED=str(self.case/'committed'),
            OC_V5_RELEASE_POLICY_CONTEXT=str(self.case/'policy/unresolved.json'),OC_V5_AUTORECOVER='off',
            OC_V5_TASK_SPOOL_DIR=str(self.case/'spool'),OC_V5_LEASE_DRY='1',PYTHONDONTWRITEBYTECODE='1')
        (self.case/'before').mkdir()
        (self.case/'before/.complete').write_text(json.dumps({'sourceCommit':self.before}))
        (self.case/'live').symlink_to(self.case/'before')
        (self.case/'survivor').write_text('phase=committed\n')
        (self.case/'committed').touch()
        self.bash('source "$1/v5-lease-lib.sh"; lease_init_db')
        self.add_ride('111111111111','2019-01-01T00:00:00Z')
        self.tid='tr-20261030T000000Z-111111111111'
        self.failed(self.tid)

    def sql(self,query,args=()):
        with sqlite3.connect(self.db) as c:
            return c.execute(query,args).fetchall()

    def bash(self,body,check=True):
        result=subprocess.run(['bash','-euo','pipefail','-c',body,'fixture',str(SCRIPTS)],
                              env=self.env,text=True,capture_output=True,timeout=20)
        if check: self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        return result

    def tick(self):
        return self.bash('''source "$1/v5-lease-worker.sh"
lease_deploy_process_running() { return 1; }
lease_in_cutover_grace() { return 1; }
prewarm_quiesce() { return 0; }
train_retry_reconcile
dispatch_train
''')

    def add_ride(self,suffix,stamp):
        self.sql("INSERT INTO lease(id,resource,mode,status,owner,owner_uid,want_sha,created_at,updated_at) VALUES(?,'deploy:selfhost','ride','registered','fixture','3',?,?,?)",
                 ('ls-20261030T000000Z-'+suffix,self.sha,stamp,stamp))

    def failed(self,tid,phase='E3.wait-idle',text=None,notes=None,sha=None,actor='deploy:123'):
        sha=sha or self.sha
        path=self.case/(tid+'.log')
        path.write_text(text or '2026-10-30T00:00:00Z   ✗ 等待空闲 600s 超时;拒绝切换,旧 master 继续运行\n')
        path.with_suffix('.summary.json').write_text(json.dumps({'trainId':tid,'sourceCommit':sha,
            'final':True,'result':'failed','failedPhase':phase,'notes':notes or {}}))
        self.sql("INSERT INTO train(id,resource,target_sha,status,owner,log_path,evidence_json,reason,created_at,finished_at,updated_at) VALUES(?,'deploy:selfhost',?,'failed','fixture',?,'{}','fixture failure','2020-01-01T00:00:00Z','2020-01-01T00:00:01Z','2020-01-01T00:00:01Z') ON CONFLICT(id) DO UPDATE SET status='failed',reason='fixture failure',finished_at='2020-01-01T00:00:01Z'",(tid,sha,str(path)))
        self.sql("INSERT INTO event(subject_id,event,actor,detail,created_at) VALUES(?,'train-failed',?,'fixture','2020-01-01T00:00:01Z')",(tid,actor))

    def planned(self):
        return self.sql("SELECT id FROM train WHERE status='planned'")[0][0]

    def test_one_retry_then_stop_and_durable_inbox(self):
        self.tick()
        retry=self.planned()
        self.assertEqual(self.sql('SELECT target_sha,reason FROM train_auto_retry'),[(self.sha,'user_idle_timeout')])
        self.failed(retry,actor='worker:456')
        for _ in range(3): self.tick()
        self.assertEqual(self.sql('SELECT count(*) FROM train'),[(2,)])
        self.assertEqual(self.sql('SELECT result FROM train_auto_retry'),[('failed',)])
        self.assertEqual(self.sql('SELECT status FROM lease'),[('failed',)])
        self.assertEqual(self.sql('SELECT count(*) FROM train_retry_alert'),[(1,)])
        self.assertEqual(self.sql("SELECT count(*) FROM outbox WHERE kind='train_alert'"),[(1,)])
        # Stub psql models a committed inbox write whose response is lost once.
        fake=self.case/'psql'
        fake.write_text('''#!/usr/bin/env python3
import pathlib,re,sys
p=pathlib.Path(__file__).with_name('inbox')
args=' '.join(sys.argv[1:]); sql=sys.stdin.read()
assert '-d openclaude_v5_selfhost' in args
assert 'WHERE NOT EXISTS' in sql and 'thread_key' in sql
thread=next(x.split('=',1)[1] for x in sys.argv[1:] if x.startswith('thread='))
assert re.fullmatch('[a-z0-9:_-]{1,160}',thread)
if not p.exists():
 p.write_text(args); sys.exit(1)
sys.exit(0)
''')
        fake.chmod(0o755); self.env['OC_V5_LEASE_RETRY_PSQL_BIN']=str(fake)
        for _ in range(3): self.bash('source "$1/v5-lease-worker.sh"; deliver_train_retry_alerts')
        self.assertEqual(self.sql('SELECT attempts,delivered_at IS NOT NULL FROM train_retry_alert'),[(2,1)])
        self.assertIn('selfhost-train-retry:'+retry.lower()+':3',(self.case/'inbox').read_text())
        status=json.loads(self.bash('bash "$1/oc-lease.sh" status --json').stdout)
        self.assertEqual(status['auto_retry_metrics']['retryFailed'],1)
        self.assertTrue(status['retry_alerts'])

    def test_success_is_durable_in_metrics_and_events(self):
        self.tick(); retry=self.planned()
        self.sql("UPDATE train SET status='committed',finished_at='2020-01-01T00:00:02Z' WHERE id=?",(retry,))
        self.bash('source "$1/v5-lease-worker.sh"; train_retry_reconcile; train_retry_reconcile')
        self.assertEqual(self.sql('SELECT result FROM train_auto_retry'),[('committed',)])
        self.assertEqual(self.sql("SELECT count(*) FROM event WHERE event='train-auto-retry-result'"),[(1,)])
        self.assertEqual(self.sql('SELECT count(*) FROM train_retry_alert'),[(0,)])
        status=json.loads(self.bash('bash "$1/oc-lease.sh" status --json').stdout)
        self.assertEqual(status['auto_retry_metrics']['retrySucceeded'],1)

    def test_manual_registration_does_not_reset_budget(self):
        self.tick(); retry=self.planned(); self.failed(retry)
        self.tick()
        self.add_ride('222222222222','2099-01-01T00:00:00Z')
        self.tick(); manual=self.planned()
        self.assertEqual(self.sql('SELECT count(*) FROM train'),[(3,)])
        self.sql("UPDATE lease SET created_at='2019-01-01T00:00:00Z' WHERE status='registered'")
        self.failed(manual); self.tick(); self.tick()
        self.assertEqual(self.sql('SELECT count(*) FROM train'),[(3,)])
        self.assertEqual(self.sql('SELECT count(*) FROM train_auto_retry'),[(1,)])

    def test_unknown_and_recovery_failures_never_retry(self):
        for text,phase in [('✗ hard assertion failed\n','C.system-executor'),
                           ('# Subtest: upstream_failed: ECONNRESET\nok 21 - upstream_failed: ECONNRESET\n✗ staging npm ci 失败\n','B')]:
            self.failed(self.tid,phase,text)
            self.tick()
            self.assertEqual(self.sql('SELECT count(*) FROM train'),[(1,)])
            self.sql("UPDATE lease SET status='registered'")
        self.failed(self.tid)
        self.sql("UPDATE train SET evidence_json=? WHERE id=?",(json.dumps({'phase':'mutated'}),self.tid))
        self.tick(); self.assertEqual(self.sql('SELECT count(*) FROM train'),[(1,)])

    def test_all_four_existing_classes_and_tap_false_positives(self):
        cases=[('A','✗ 发车准入:主机持续繁忙超过 900s\n',{'hostIdle.admission.timeout':'load1=8'},'admission_timeout'),
            ('C.parallel','✗ pinned C/D 并行任务失败或负载预算超时\n',{'job.C.delegate-billing.admissionFailure':'admission-timeout'},'admission_timeout'),
            ('P.runtime-wait','── build runtime release(git archive + prune + finalize) ──\nbun install v1.3.14\nerror: failed to download @biomejs/cli-linux-x64@2.5.14: Fail\nFATAL[hotcfg]: ccb bun install/build 失败\n✗ runtime release 后台构建失败 rc=1(live 未改;日志见上)\n',{},'dependency_download_failed'),
            ('B','npm error code ECONNRESET\n✗ staging npm ci 失败\n',{},'dependency_download_failed'),
            ('B','npm error code EUSAGE\n✗ staging npm ci 失败\n',{},''),
            ('C.parallel','✗ gate assertion failed\n',{'job.C.delegate-billing.admissionFailure':'admission-timeout','job.D.rc':'1'},'')]
        for phase,text,notes,want in cases:
            with self.subTest(phase=phase,text=text):
                self.failed(self.tid,phase,text,notes)
                got=self.bash('source "$1/v5-lease-worker.sh"; train_retry_classify "'+self.tid+'"').stdout.strip()
                self.assertEqual(got,want)

    def test_tip_move_runs_current_source_and_records_previous_source(self):
        self.failed(self.tid,'P.platform-bundle','✗ selfhost tip changed; discard prepared '+self.before+' and prepare the new tip\n',sha=self.before)
        self.sql('UPDATE train SET target_sha=? WHERE id=?',(self.before,self.tid))
        self.tick()
        self.assertEqual(self.sql('SELECT target_sha,source_sha,reason FROM train_auto_retry'),[(self.sha,self.before,'tip_advanced')])
        self.assertEqual(self.sql("SELECT target_sha FROM train WHERE status='planned'"),[(self.sha,)])

    def test_reservation_conflict_rolls_back_planned_train(self):
        # Native transaction: two independent planners cannot consume the budget twice.
        self.tick(); before=self.sql('SELECT count(*) FROM train')[0][0]
        retry=self.planned(); self.sql("UPDATE train SET status='failed' WHERE id=?",(retry,))
        result=self.bash('''source "$1/v5-lease-lib.sh"
lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
INSERT INTO train(id,resource,target_sha,status,owner,created_at,updated_at) VALUES('tr-20261030T000001Z-333333333333','deploy:selfhost','''+"'"+self.sha+"'"+''','planned','fixture','now','now');
INSERT INTO train_auto_retry SELECT resource,target_sha,source_train_id,source_sha,'tr-20261030T000001Z-333333333333',reason,result,created_at,finished_at FROM train_auto_retry;
COMMIT;
SQL
''',check=False)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.sql('SELECT count(*) FROM train'),[(before,)])

    def test_idle_retry_reuses_real_prepared_receipt_and_repeats_e1_through_g(self):
        spec = importlib.util.spec_from_file_location('prepared_retry_fixture', SCRIPTS/'__tests__/v5SelfhostPreparedCutover.test.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        p = module.PreparedCutover()
        self.addCleanup(p.doCleanups)
        p.setUp()
        p.cutover('cutover_wait_for_user_idle() { fixture_event idle-timeout; return 1; }',ok=False)
        self.assertTrue(p.h.receipt.exists())
        p.assert_old_runtime()
        p.bash('selfhost_prepare_candidate "$SHA"')
        self.assertNotIn('build',p.events())
        p.cutover(ok=True)
        p.assert_new_runtime()
        self.assertEqual(p.events().count('E1'),2)
        self.assertEqual(p.events().count('E2'),2)
        self.assertIn('G',p.events())
        self.assertFalse(p.h.receipt.exists())


if __name__ == '__main__':
    unittest.main()
