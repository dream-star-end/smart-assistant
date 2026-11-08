#!/usr/bin/env python3
import importlib.util, json, os, pathlib, signal, tempfile, unittest
from unittest.mock import patch
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('hostd', HERE / 'oc-remote-hostd.py')
hostd = importlib.util.module_from_spec(spec); spec.loader.exec_module(hostd)
CLI = str(HERE / 'fixtures/codex-app-server.py')
class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = pathlib.Path(self.tmp.name)
        check_sources = hostd.codex_check_config_sources
        checker = patch.object(hostd, "codex_check_config_sources", lambda ch,cwd: check_sources(ch,cwd,self.home/"etc"))
        checker.start(); self.addCleanup(checker.stop)
        self.scopes = {}
        def command(unit, argv, env):
            self.scopes[unit] = pathlib.Path(env['CODEX_HOME']) / 'fixture.pid'
            return ['/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],*argv]
        def stop(unit):
            path = self.scopes.get(unit,self.home/'no-old-worker')
            if path.exists():
                try: os.kill(int(path.read_text()),signal.SIGTERM)
                except ProcessLookupError: pass
        resource = hostd.engine_resources()
        from types import SimpleNamespace
        fixture = SimpleNamespace(config=resource.config, admit=lambda *a,**k: None, release=lambda *a: None)
        for name, fn in [('codex_scope_command',command),('codex_scope_stop',stop),
                         ('engine_resources',lambda: fixture)]:
            patcher = patch.object(hostd,name,fn); patcher.start(); self.addCleanup(patcher.stop)
    def profile(self, rel, name):
        p = self.home / rel; p.mkdir(parents=True)
        (p/'auth.json').write_text(json.dumps({'access_token':'fake-not-authenticated-token','available_models':[{'id':'forged'}]}))
        (p/'fixture.json').write_text(json.dumps({'pages': [
            {'data':[{'id':'display-'+name,'model':name,'displayName':name,'supportedReasoningEfforts':[{'reasoningEffort':'low'}], 'inputModalities':['text','image'], 'serviceTiers':['fast']}], 'nextCursor':'1'},
            {'data':[{'id':name+'-second','model':name+'-second'}], 'nextCursor':None}]}))
        return p
    def probe(self):
        with patch.object(hostd,'resolve_binary_path',return_value=CLI), patch.object(hostd,'run_cmd_version',return_value='codex-cli 0.167.0'):
            return hostd.probe_other_engine(self.home,'codex','codex',[self.home/'.codex/auth.json'])
    def test_real_model_list_all_profiles_not_auth_seed(self):
        for rel,name in [('.codex','default'),('.codex-team','team'),('accounts/x/.codex','x'),('accounts/y','y')]: self.profile(rel,name)
        got = {p['profile_name']:p for p in self.probe()}
        self.assertEqual(set(got),{'default','team','x','y'})
        for name,p in got.items():
            self.assertEqual([x['upstream_model_id'] for x in p['discovered_models']],[name,name+'-second'])
            self.assertEqual(p['runner_mode'],'app-server')
            self.assertFalse(p['execution_ready'])
            self.assertEqual(p['discovered_models'][0]['input_modalities'],['text','image'])
    def test_managed_profile_probes_while_a_runtime_lane_owns_the_profile(self):
        # OCV5-746 §4: a running app-server lane is not a probe blocker; discovery only excludes
        # another probe. The runtime claim is neither read as a probe claim nor cleared here.
        p=self.profile('.oc-remote-codex/profiles/default/codex-home','managed')
        (p/'OC_REMOTE_ACTIVE.json').write_text('{"kind":"runtime","root":"/home/box/oc-codexremote-a"}')
        got=self.probe()[0]
        self.assertTrue(got['models_observed'])
        self.assertEqual(got['discovered_models'][0]['upstream_model_id'],'managed')
        self.assertTrue((p/'OC_REMOTE_ACTIVE.json').exists())
    def test_dead_probe_claim_reconciles_only_after_proof(self):
        p=self.profile('.codex','default')
        claim={'kind':'probe','unit':'oc-codex-probe-'+'a'*32+'.scope','bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
               'ownerPid':99999999,'ownerStartTicks':'1'}
        active=p/'PROBE_ACTIVE.json';active.write_text(json.dumps(claim));os.chmod(active,0o600)
        with patch.object(hostd,'codex_scope_stop',side_effect=ValueError('CODEX_STOP_UNKNOWN')):
            failed=self.probe()[0]
        self.assertEqual(failed['error_code'],'CODEX_STOP_UNKNOWN');self.assertTrue(active.exists())
        passed=self.probe()[0]
        self.assertTrue(passed['models_observed']);self.assertFalse(active.exists())
        self.assertTrue((p/(claim['unit']+'.revoked')).exists())
    def test_live_mux_owner_can_reconcile_finished_unknown_request(self):
        p=self.profile('.codex','default'); stop=hostd.codex_scope_stop
        def unknown(unit):
            stop(unit)
            raise ValueError('CODEX_STOP_UNKNOWN')
        with patch.object(hostd,'codex_scope_stop',unknown): got=self.probe()[0]
        self.assertEqual(got['error_code'],'CODEX_STOP_UNKNOWN')
        self.assertTrue((p/'PROBE_ACTIVE.json').exists())
        self.assertTrue(self.probe()[0]['models_observed'])
        self.assertFalse((p/'PROBE_ACTIVE.json').exists())
    def test_tiny_launcher_never_fabricates_models(self):
        p = self.profile('.codex','default'); (p/'fixture.json').unlink()
        got = self.probe()[0]
        self.assertFalse(got['logged_in']); self.assertEqual(got['discovered_models'],[])
    def test_partial_and_cursor_cycle_are_not_catalog(self):
        p = self.profile('.codex','default')
        (p/'fixture.json').write_text(json.dumps({'pages':[{'data':[{'id':'actual'}],'nextCursor':'0'}]}))
        got = self.probe()[0]
        self.assertEqual(got['discovered_models'],[]); self.assertFalse(got['logged_in'])
    def test_execution_snapshot_is_exact_observed_intersection_and_real_bytes(self):
        import hashlib
        p=self.profile('.codex','default')
        model={'upstream_model_id':'real','native':{'id':'real','model':'real','serviceTiers':['fast']}}
        (p/'models_cache.json').write_text(json.dumps({'models':[{'slug':'real','tool_mode':'direct'},{'slug':'not-observed'}]}))
        native=self.home/'native';native.write_bytes(b'fixture-native-not-production')
        with patch.object(hostd,'CODEX_NATIVE_BINARY',native):
            snapshot,error=hostd.codex_execution_snapshot(p,CLI,[model])
            self.assertIsNone(error)
            self.assertEqual(snapshot['modelCatalog'],{'models':[{'slug':'real','tool_mode':'direct'}]})
            self.assertEqual(snapshot['modelList'],[model['native']])
            self.assertEqual(snapshot['nativeSha256'],hashlib.sha256(native.read_bytes()).hexdigest())
            (p/'models_cache.json').write_text('{"models":[]}')
            self.assertEqual(hostd.codex_execution_snapshot(p,CLI,[model]),(None,'CODEX_SNAPSHOT_UNAVAILABLE'))
    def test_codex_version_probe_never_touches_default_codex_home(self):
        # A bare `codex --version` initializes $HOME/.codex; the probe must use a throwaway
        # HOME/CODEX_HOME so Gate G's ~/.codex check cannot be poisoned by a version query.
        fake = self.home/'fake-codex'
        fake.write_text('#!/usr/bin/env python3\n'
            'import os,pathlib\n'
            'h=pathlib.Path(os.environ.get("CODEX_HOME") or (pathlib.Path(os.environ["HOME"])/".codex"))\n'
            '(h/"tmp").mkdir(parents=True,exist_ok=True)\n'
            'print("codex-cli 0.167.0 "+str(h/"tmp"/"arg0-linux"))\n')
        fake.chmod(0o755)
        line = hostd.run_cmd_version(str(fake), isolated_home=True)
        self.assertTrue(line.startswith('codex-cli 0.167.0 '))
        marker = pathlib.Path(line.split(' ',2)[2])
        self.assertFalse(marker.exists())  # scratch home removed immediately
        self.assertNotIn(str(pathlib.Path.home()), str(marker))
    def test_account_null_and_no_auth_remain_negative(self):
        p = self.profile('.codex','default'); data=json.loads((p/'fixture.json').read_text()); data['account']=None
        (p/'fixture.json').write_text(json.dumps(data))
        self.assertFalse(self.probe()[0]['logged_in'])

if __name__=='__main__': unittest.main()
