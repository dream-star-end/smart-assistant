#!/usr/bin/env python3
"""Real durable claims + multiprocessing arbitration; systemd telemetry isolated from the host.
Node smoke separately verifies actual cgroups and a running CLI surviving refused admission.
"""
import importlib.util
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('resources',Path(__file__).with_name('remote-engine-resources.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
M=r.MIB

class Resources(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.env=patch.dict(os.environ,{'OC_REMOTE_RESOURCE_ROOT':self.tmp.name,
            'OC_REMOTE_NODE_MEMORY_BUDGET':str(128*1024*M),'OC_REMOTE_CODEX_MEMORY_MAX':str(32*1024*M),'OC_REMOTE_CC_MEMORY_MAX':str(32*1024*M),
            'OC_REMOTE_CODEX_TASKS_MAX':'8192','OC_REMOTE_CC_TASKS_MAX':'8192'})
        self.env.start();self.addCleanup(self.env.stop)
        self.used={};self.free=64*1024*M
        for name,fn in [('ensure_slice',r.config),('memory_used',lambda u:self.used.get(u,0)),('available',lambda:self.free)]:
            p=patch.object(r,name,fn);p.start();self.addCleanup(p.stop)
    def admit(self,i,engine='codex',profile='one'):
        return r.admit(f'{engine}-{i}',engine,profile,{f'oc-{engine}-{i}.scope':512*M})
    def test_six_simultaneous_starters_five_claims_no_login_lock(self):
        ctx=multiprocessing.get_context('fork');start=ctx.Event();q=ctx.Queue()
        def worker(i):
            start.wait()
            try:self.admit(i);q.put('admitted')
            except RuntimeError:q.put('refused')
        workers=[ctx.Process(target=worker,args=(i,)) for i in range(6)]
        try:
            for p in workers:p.start()
            start.set();results=[q.get(timeout=5) for _ in workers]
            self.assertEqual(results.count('admitted'),5)
            self.assertEqual(results.count('refused'),1)
            self.assertEqual(len(r.records()),5)
            self.admit('other',profile='two');self.admit('other',engine='cc')
            self.assertEqual(len(r.records()),7)
        finally:
            start.set()
            for p in workers:
                p.join(5)
                if p.is_alive():p.terminate();p.join()
            q.close();q.join_thread()
    def test_ready_does_not_free_future_growth_budget_or_oom_siblings(self):
        with patch.dict(os.environ,{'OC_REMOTE_CODEX_MEMORY_MAX':str(1100*M)}):
            self.admit('a')
            self.used['oc-codex-a.scope']=10*M # ready, but still far below its growth ceiling
            with self.assertRaises(r.MemoryExhausted):self.admit('b')
            self.assertEqual(len(r.records()),1)
            self.used['oc-codex-a.scope']=500*M # existing lane safely grows within its own cap
            with self.assertRaises(r.MemoryExhausted):self.admit('b')
    def test_other_engine_still_reserves_same_physical_node_and_probe_budget(self):
        self.env.stop();self.env.start()
        os.environ['OC_REMOTE_NODE_MEMORY_BUDGET']=str(1100*M)
        self.free=1000*M
        self.admit('a','cc')
        with self.assertRaises(r.MemoryExhausted):self.admit('b')
        self.assertEqual(len(r.records()),1)
        # A probe is not a profile slot, but its memory is reserved until proven stopped.
        self.free=2000*M
        os.environ['OC_REMOTE_NODE_MEMORY_BUDGET']=str(2000*M)
        r.admit('probe','codex','one',{'oc-codex-probe.scope':512*M},kind='probe')
        self.assertEqual(len(r.records()),2)
    def test_unknown_scope_stop_cannot_release_claim(self):
        self.admit('a')
        with patch.object(r,'state',return_value={'ActiveState':'active','ControlGroup':'/still-running'}):
            with self.assertRaises(RuntimeError):r.release('codex-a')
        self.assertEqual(len(r.records()),1)
        with patch.object(r,'state',return_value={'ActiveState':'inactive','ControlGroup':''}):r.release('codex-a')
        self.assertEqual(r.records(),[])
    def test_residency_telemetry_race_cannot_invent_node_capacity(self):
        with patch.dict(os.environ,{'OC_REMOTE_NODE_MEMORY_BUDGET':str(800*M)}):
            self.free=800*M
            row={'engine':'cc','kind':'lane','scopes':{'oc-cc-a.scope':480*M}}
            # Another engine can free/reallocate its 400 MiB between any kernel reads.
            with patch.object(r,'memory_used',side_effect=lambda u:400*M if u=='oc-cc-a.scope' else 0):
                self.assertFalse(r.snapshot('codex',{'oc-codex-new.scope':480*M},[row])['memoryOk'])
    def test_cc_single_file_c_entry_loads_exact_resource_module_without_file(self):
        import base64,zlib,subprocess,sys
        source=Path(__file__).with_name('cc5-host-controller.py').read_text()
        ns={'__name__':'cc5_entry'}
        exec(compile(source,'cc5-task-controller','exec'),ns)
        self.assertNotIn('__file__',ns)
        self.assertEqual(zlib.decompress(base64.b64decode(ns['RESOURCE_MODULE_B64'])),Path(r.__file__).read_bytes())
        loaded=ns['engine_resources']() # No mock: this is the precise former NameError boundary.
        self.assertEqual(loaded.config('cc')['app'],640*M)
        code="import base64; ns={'__name__':'cc5_entry'}; exec(compile(base64.b64decode(%r),'cc5-task-controller','exec'),ns); print(ns['engine_resources']().config('cc')['app'])"%base64.b64encode(source.encode()).decode()
        result=subprocess.run([sys.executable,'-I','-B','-c',code],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),str(640*M))
    def test_loaded_slice_config_mismatch_never_shrinks_running_slice(self):
        original=spec.loader
        fresh=importlib.util.module_from_spec(spec);original.exec_module(fresh)
        with patch.object(fresh,'state',return_value={'LoadState':'loaded','ActiveState':'active','MemoryMax':'1','TasksMax':'768'}),patch.object(fresh,'systemctl') as ctl:
            with self.assertRaises(RuntimeError):fresh.ensure_slice('codex')
            ctl.assert_not_called()

if __name__=='__main__':unittest.main()
