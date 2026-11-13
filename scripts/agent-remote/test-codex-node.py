#!/usr/bin/env python3
"""Behavior tests: native observation + actual stdio/AF_UNIX + real container file effects."""
import base64
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import subprocess
import sys
import tempfile
import unittest
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/name)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
client=load('codex-fixed-mcp.py'); ctrl=load('codex-host-controller.py')

class NodeTests(unittest.TestCase):
    def test_native_artifact_hash_fits_bounded_socket_memory(self):
        artifact=Path(tempfile.gettempdir())/('codex-hash-'+secrets.token_hex(6))
        self.addCleanup(artifact.unlink)
        digest=ctrl.hashlib.sha256()
        with artifact.open('wb') as out:
            for _ in range(128):
                block=b'a'*(1024*1024);out.write(block);digest.update(block)
        code="""import importlib.util,resource,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('controller',sys.argv[1])
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
resource.setrlimit(resource.RLIMIT_AS,(48*1024*1024,48*1024*1024))
print(c.file_sha(Path(sys.argv[2])))
"""
        result=subprocess.run([sys.executable,'-I','-B','-c',code,str(HERE/'codex-host-controller.py'),str(artifact)],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),digest.hexdigest())

    def setUp(self):
        # The controller only accepts /tmp/oc-codex-<[a-z0-9-]{8,50}>/run-* experiment roots, and
        # tempfile's random suffix can contain '_' — name it ourselves so the harness cannot flake.
        self.root=Path(tempfile.gettempdir())/('oc-codex-test-'+secrets.token_hex(6))
        self.root.mkdir(mode=0o700);self.addCleanup(shutil.rmtree,self.root,ignore_errors=True)
        self.m={'operationId':'operation','runId':'run','generation':'1','nativeThreadId':None,'model':'fixture-model'}
        self.catalog={'tools':[{'name':'write_marker','description':'Append one container marker','inputSchema':{'type':'object'}}]}
        self.write('tools.json',self.catalog)
        self.config={'version':3,'engine':'codex',**self.m,'catalogSha256':client.hashlib.sha256((self.root/'tools.json').read_bytes()).hexdigest()}
        self.write('client.json',self.config)
        self.write('model-list.json',[{'id':'fixture-model','supportedReasoningEfforts':[{'reasoningEffort':'low'}]}])
        (self.root/'observations').mkdir(mode=0o700)
        (self.root/'codex-fixed-mcp.py').write_bytes((HERE/'codex-fixed-mcp.py').read_bytes());os.chmod(self.root/'codex-fixed-mcp.py',0o400)
        self.policy=ctrl.Policy(self.root,self.m,client);self.policy.thread='thread';self.policy.turn='turn';self.policy.initialized=True
        self.params={'name':'write_marker','arguments':{'value':'container-unique'},'_meta':{'callId':'call-a','itemId':'ctc-unrelated','threadId':'thread','x-codex-turn-metadata':{'turn_id':'turn'}}}
    def write(self,name,value):
        (self.root/name).write_text(json.dumps(value));os.chmod(self.root/name,0o600)
    def event(self,**overrides):
        item={'id':'call-a','type':'mcpToolCall','server':'ocbridge','tool':'write_marker','arguments':self.params['arguments'],**overrides}
        return {'method':'item/started','params':{'threadId':'thread','turnId':'turn','item':item}}
    def body(self): return client.request_body(self.config,self.catalog,7,self.params)
    def socket(self):
        p=subprocess.Popen([sys.executable,'-I','-B',str(HERE/'codex-mcp-socket.py'),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        def cleanup():
            if p.poll() is None: p.kill()
            p.communicate(timeout=5)
        self.addCleanup(cleanup)
        ready=self.read(p);self.assertEqual(ready['kind'],'socket-ready');return p
    def read(self,p):
        self.assertTrue(select.select([p.stdout],[],[],5)[0],'socket did not emit')
        line=p.stdout.readline();self.assertTrue(line,p.stderr.read().decode() if p.poll() is not None else 'EOF');return json.loads(line)
    def invoke(self):
        p=subprocess.Popen([sys.executable,'-I','-B',str(HERE/'codex-fixed-mcp.py'),str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        request={'jsonrpc':'2.0','id':7,'method':'tools/call','params':self.params}
        p.stdin.write((json.dumps(request)+'\n').encode());p.stdin.flush()
        self.addCleanup(lambda: p.kill() if p.poll() is None else None)
        return p
    def test_real_socket_call_observed_once_writes_container_marker(self):
        self.policy.outgoing(self.event()); sock=self.socket(); mcp=self.invoke()
        req=self.read(sock);self.assertEqual(req['version'],3)
        body=json.loads(base64.b64decode(req['body']));self.assertEqual(body['callId'],'call-a');self.assertEqual(body['rpcId'],7)
        # This is the container execution boundary, not a mock function call count.
        marker=self.root/'container-marker';marker.write_text(body['arguments']['value']+'\n')
        result={k:body[k] for k in client.IDENTITY};result.update(version=3,engine='codex',ok=True,result={'content':[{'type':'text','text':marker.read_text()}],'isError':False})
        response={'version':3,'engine':'codex','kind':'tool-response','seq':req['seq'],'status':200,'body':base64.b64encode(json.dumps(result).encode()).decode()}
        sock.stdin.write((json.dumps(response)+'\n').encode());sock.stdin.flush()
        reply=self.read(mcp);self.assertEqual(reply['result']['content'][0]['text'],'container-unique\n')
        mcp.stdin.close();mcp.wait(timeout=5);mcp.stdout.close();mcp.stderr.close()
        duplicate=self.invoke();out,_=duplicate.communicate(timeout=5)
        self.assertIn('error',json.loads(out));self.assertEqual(marker.read_text(),'container-unique\n')
    def test_unobserved_call_has_no_container_dispatch(self):
        sock=self.socket();mcp=self.invoke();out,_=mcp.communicate(timeout=5)
        self.assertIn('error',json.loads(out));self.assertFalse(select.select([sock.stdout],[],[],.1)[0])
        self.assertEqual(list((self.root/'tool-attempts').glob('*.attempt.json')),[])
    def test_wrong_args_do_not_dispatch(self):
        self.policy.outgoing(self.event());self.params['arguments']={'value':'forged'}
        sock=self.socket();mcp=self.invoke();out,_=mcp.communicate(timeout=5)
        self.assertIn('error',json.loads(out));self.assertEqual(list((self.root/'tool-attempts').glob('*')),[])
    def test_item_id_is_not_call_id(self):
        self.params['_meta'].pop('callId')
        with self.assertRaises(ValueError):self.body()
    def test_unknown_item_and_foreign_server_are_fatal(self):
        for item in [{'type':'commandExecution'},{'server':'foreign'}]:
            with self.assertRaisesRegex(ValueError,'CODEX_NATIVE_ITEM_REJECTED'):self.policy.outgoing(self.event(**item))
        self.assertEqual(list((self.root/'observations').iterdir()),[])
    def test_reverse_rpc_and_arbitrary_input_rejected(self):
        with self.assertRaisesRegex(ValueError,'CODEX_SERVER_REQUEST_REJECTED'):
            self.policy.outgoing({'id':4,'method':'item/tool/requestUserInput','params':{}})
        for method in ['command/exec','config/write','thread/shellCommand']:
            with self.assertRaisesRegex(ValueError,'CODEX_RPC_REJECTED'):
                self.policy.incoming({'id':method,'method':method,'params':{}})
    def test_turn_policy_reasserted_and_wrong_thread_rejected(self):
        self.policy.turn=None
        frame=self.policy.incoming({'id':1,'method':'turn/start','params':{'threadId':'thread','input':[{'type':'text','text':'Hi'}],
            'effort':'low','sandboxPolicy':{'type':'dangerFullAccess'},'cwd':'/home/box','model':'another'}})
        self.assertEqual(frame['params']['sandboxPolicy']['type'],'readOnly');self.assertEqual(frame['params']['model'],'fixture-model')
        with self.assertRaisesRegex(ValueError,'CODEX_RPC_REJECTED'):
            self.policy.incoming({'id':2,'method':'turn/start','params':{'threadId':'foreign','input':[]}})
    def test_thread_unsubscribe_only_for_own_idle_thread(self):
        with self.assertRaisesRegex(ValueError,'CODEX_RPC_REJECTED'):  # mid-turn
            self.policy.incoming({'id':10,'method':'thread/unsubscribe','params':{'threadId':'thread'}})
        self.policy.turn=None
        for p in ({'threadId':'foreign'},{},{'threadId':'thread','extra':1}):
            with self.assertRaisesRegex(ValueError,'CODEX_RPC_REJECTED'):
                self.policy.incoming({'id':'u'+str(len(p)),'method':'thread/unsubscribe','params':p})
        frame=self.policy.incoming({'id':11,'method':'thread/unsubscribe','params':{'threadId':'thread'}})
        self.assertEqual(frame['params'],{'threadId':'thread'})
        with self.assertRaisesRegex(ValueError,'CODEX_RPC_REJECTED'):  # no resume while the unload is pending
            self.policy.incoming({'id':12,'method':'thread/resume','params':{'threadId':'thread'}})
        self.policy.outgoing({'id':11,'result':{'status':'unsubscribed'}})
        self.policy.outgoing({'method':'thread/closed','params':{'threadId':'thread'}})
        self.policy.incoming({'id':13,'method':'thread/resume','params':{'threadId':'thread','baseInstructions':'new'}})
    def test_pinned_catalog_excludes_unobserved_models_and_disables_native_tools(self):
        result=ctrl.pinned_catalog([{'id':'visible'}],{'models':[{'slug':'visible','tool_mode':'code_mode_only'},{'slug':'cache-only'}]})
        self.assertEqual([m['slug'] for m in result['models']],['visible']);self.assertEqual(result['models'][0]['tool_mode'],'direct')
        self.assertIsNone(result['models'][0]['apply_patch_tool_type'])
        with self.assertRaises(ValueError):ctrl.pinned_catalog([{'id':'missing'}],{'models':[]})
    def test_stop_proof_cannot_race_pre_scope_writer(self):
        ctrl.fence(self.root,{**self.m,'profileId':'p','authEpoch':'1'})
        fd=ctrl.lock(self.root/'APP-WRITER.lock')
        try:
            with self.assertRaisesRegex(ValueError,'CODEX_PROFILE_BUSY'):
                ctrl.proof(self.root,{**self.m,'profileId':'p','authEpoch':'1'},None)
        finally: os.close(fd)
    def test_ssh_guard_exact_roles_digest_and_immutable_path(self):
        guard=load('codex-ssh-guard.py')
        trusted=Path('/usr/bin/true').resolve()
        config={'rootPrefix':'/home/box/oc-codexremote-', 'controllers':[{'path':str(trusted),'sha256':client.hashlib.sha256(trusted.read_bytes()).hexdigest()}]}
        args=['/usr/bin/python3','-I','-B',str(trusted),'stop','/home/box/oc-codexremote-'+'a'*16]
        command=' '.join(guard.quote(x) for x in args)
        self.assertEqual(guard.verified_argv(command,config),args)
        for changed in [args[:4]+['_worker',args[5]],args+['--model','extra']]:
            with self.assertRaises(ValueError):guard.verified_argv(' '.join(guard.quote(x) for x in changed),config)
        unsafe=self.root/'controller.py';unsafe.write_text('print(1)')
        config['controllers']=[{'path':str(unsafe),'sha256':client.hashlib.sha256(unsafe.read_bytes()).hexdigest()}]
        args[3]=str(unsafe)
        with self.assertRaises(ValueError):guard.verified_argv(' '.join(guard.quote(x) for x in args),config)
    def test_fence_stop_absent_and_unpublished_manifest_blocks_late_provision(self):
        home=self.root/'profile/codex-home';home.mkdir(parents=True,mode=0o700)
        (home/'auth.json').write_text('{}');os.chmod(home/'auth.json',0o600)
        for partial in ('absent','unpublished','published'):
            root=self.root/('run-'+partial+'00001')
            if partial!='absent':
                root.mkdir(mode=0o700);(root/'.manifest-interrupted').write_text('{')
            m={'version':1,'engine':'codex','root':str(root),'operationId':'operation','runId':'run','generation':'1',
               'profileId':'default','authEpoch':'epoch1','model':'fixture-model','nativeThreadId':None,'codexHome':str(home),
               'controllerSha256':ctrl.sha((HERE/'codex-host-controller.py').read_bytes()),'cliSha256':'a'*64,'nativeSha256':'b'*64}
            if partial=='published':
                pid=os.fork()
                if pid==0:
                    ctrl.sync_dir=lambda path: os._exit(77) # publication done, cleanup not reached
                    ctrl.publish_manifest(root,m); os._exit(1)
                _,status=os.waitpid(pid,0);self.assertEqual(os.waitstatus_to_exitcode(status),77)
                self.assertEqual((root/'MANIFEST.json').stat().st_nlink,1)
            def call(role,packet=None):
                return subprocess.run([sys.executable,'-I','-B',str(HERE/'codex-host-controller.py'),role,str(root)],
                    input=(json.dumps(packet)+'\n').encode() if packet is not None else b'',capture_output=True,timeout=15)
            fd=ctrl.creation_lock(root)
            try:
                busy=call('fence-stop',m);self.assertEqual(busy.returncode,126)
                self.assertFalse((root/'STOPPING.json').exists())
            finally:os.close(fd)
            for role in ('fence-stop','prove-stopped'):
                result=call(role,m if role=='fence-stop' else None)
                self.assertEqual(result.returncode,0,role+': '+result.stderr.decode())
                proof=json.loads(result.stdout);self.assertTrue(proof['remoteStopped']);self.assertEqual(proof['scopes'],[])
            late=call('provision',{'manifest':m,'tools':self.catalog,'modelList':[{'id':'fixture-model'}],
                'modelCatalog':{'models':[{'slug':'fixture-model'}]}})
            self.assertEqual(late.returncode,126)
            self.assertEqual(call('launch').returncode,126)
            self.assertFalse((root/'PROVISIONED.json').exists())
            self.assertFalse((root/'APP-STARTING.json').exists())
            self.assertEqual(json.loads((root/'MANIFEST.json').read_text()),m)

    def test_mismatched_receipt_cannot_become_success(self):
        body=self.body();value={k:body[k] for k in client.IDENTITY};value.update(version=3,engine='codex',ok=True,result={'content':[],'isError':False})
        for key in ['generation','callId','nativeThreadId','nativeTurnId','inputSha256']:
            with self.assertRaises(ValueError):client.validate_response({**value,key:'wrong'},body)
if __name__=='__main__':unittest.main()
