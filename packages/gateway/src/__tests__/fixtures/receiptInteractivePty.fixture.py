import os, sys, json, time, socket, signal, re, subprocess, threading, tempfile, pty, fcntl, termios, struct, select, shlex, traceback
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
W=Path(__file__).resolve().parents[5]
d=Path(sys.argv[1]).resolve();mode=sys.argv[2] if len(sys.argv)>2 else 'ordinary';assert mode in ['ordinary','no-key','unowned'];os.chmod(d,0o700)
gateway=None;gateway_info=None
(d/'home').mkdir();(d/'config').mkdir();(d/'cwd').mkdir()
(d/'config/.claude.json').write_text(json.dumps({'hasCompletedOnboarding':True,'theme':'dark','projects':{str(d/'cwd'):{'hasTrustDialogAccepted':True}}}))
(d/'config/settings.json').write_text(json.dumps({'skipDangerousModePermissionPrompt':True,'permissions':{'allow':['Bash(*)']}}))
rows=[];fail=[];rawpty=bytearray();done=threading.Event();background=threading.Event();observed={};owned={}

def proc_state(pid):
 try:
  parts=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split();return parts[0],int(parts[1]),parts[19]
 except (OSError,ValueError,IndexError):return None
def track():
 roots=[p.pid]+([gateway.pid] if gateway else []); states={}
 for entry in Path('/proc').glob('[0-9]*/stat'):
  state=proc_state(int(entry.parent.name))
  if state:states[int(entry.parent.name)]=state
 for _ in range(16):
  added=[pid for pid,state in states.items() if state[1] in roots and pid not in roots]
  if not added:break
  roots+=added
 for pid in roots:
  if pid in states:owned[pid]=states[pid][2]
def reap_owned():
 for pid,start in owned.items():
  state=proc_state(pid)
  if state and state[0]!='Z' and state[2]==start:
   try:os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
 end=time.monotonic()+5
 while time.monotonic()<end:
  live=[pid for pid,start in owned.items() if (state:=proc_state(pid)) and state[0]!='Z' and state[2]==start]
  if not live:return
  time.sleep(.02)
 raise AssertionError('private descendants survived cleanup: '+str(live))
sentinel='D16_REAL_PTY_ORDINARY_STDOUT'
script="from pathlib import Path; import time,sys; p=Path("+repr(str(d))+ "); (p/'started').write_text('started');\nwhile not (p/'release').exists(): time.sleep(.02)\nprint('"+sentinel+"');print('D16_REAL_PTY_ORDINARY_STDERR',file=sys.stderr);sys.exit(7)"
command='python3 -c '+shlex.quote(script)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):
  try:
   b=self.rfile.read(int(self.headers.get('content-length',0)));body=json.loads(b or b'{}');assert self.headers.get('x-api-key')=='synthetic-pty-only' or self.headers.get('authorization')=='Bearer synthetic-pty-only'
   if 'count_tokens' in self.path:self.send_response(200);self.end_headers();self.wfile.write(b'{"input_tokens":100}');return
   assert self.path.startswith('/v1/messages'),self.path
   main=any(t.get('name')=='Bash' for t in body.get('tools',[]))
   row={'main':main,'path':self.path,'body':body};rows.append(row);(d/'requests.json').write_text(json.dumps(rows,indent=2))
   mains=[r for r in rows if r['main']]
   if main and len(mains)==1:c={'type':'tool_use','id':'d16_real_pty_shell','name':'Bash','input':{'command':command,'timeout':120000,'description':'Private gated shell for actual Ctrl+B'}}
   else:
    c={'type':'text','text':'D16_PTY_MODEL_DONE'}
    if main and mode=='unowned':
     results=[c for m in body['messages'] if m.get('role')=='user' for c in (m.get('content') if isinstance(m.get('content'),list) else []) if c.get('type')=='tool_result' and c.get('tool_use_id')=='d16_real_pty_shell']
     assert len(results)==1 and results[0].get('is_error') and 'receipt invocation rejected (409)' in json.dumps(results),results
     assert not (d/'started').exists();done.set()
    if main and mode!='unowned':
     blob=json.dumps([m for m in body['messages'] if m.get('role')=='user'])
     if len(mains)==2:
      assert (d/'key-sent').exists(),'must actual keyboard before background model request'
      assert sentinel not in blob,'placeholder must precede release'
      assert 'background' in blob.lower(),'real background placeholder required'
      background.set()
     if len(mains)==3:
      notifications=[c for m in body['messages'] if m.get('role')=='user' for c in (m.get('content') if isinstance(m.get('content'),list) else []) if c.get('type')=='text' and '<task-notification>' in c.get('text','')]
      assert len(notifications)==1,notifications
      text=notifications[0]['text'];assert '<status>failed</status>' in text and 'exit code 7' in text,text
      output=Path(re.search(r'<output-file>(.*?)</output-file>',text).group(1));assert output.is_relative_to(d)
      assert sentinel in output.read_text() and 'D16_REAL_PTY_ORDINARY_STDERR' in output.read_text()
      (d/'notification.json').write_text(json.dumps(notifications[0]));c={'type':'tool_use','id':'d16_real_output_read','name':'Read','input':{'file_path':str(output)}}
     if len(mains)>=4:
      reads=[c for m in body['messages'] if m.get('role')=='user' for c in (m.get('content') if isinstance(m.get('content'),list) else []) if c.get('type')=='tool_result' and c.get('tool_use_id')=='d16_real_output_read']
      assert len(reads)==1 and sentinel in json.dumps(reads) and 'D16_REAL_PTY_ORDINARY_STDERR' in json.dumps(reads),reads
      done.set()
   msg={'id':'d16_msg_'+str(len(rows)),'type':'message','role':'assistant','model':body['model'],'content':[c],'stop_reason':'tool_use' if c['type']=='tool_use' else 'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':10}}
   self.send_response(200);self.send_header('Content-Type','text/event-stream' if body.get('stream') else 'application/json');self.end_headers()
   if not body.get('stream'):self.wfile.write(json.dumps(msg).encode());return
   def emit(event,data):self.wfile.write(('event: '+event+'\ndata: '+json.dumps(data)+'\n\n').encode());self.wfile.flush()
   tool=c['type']=='tool_use';emit('message_start',{'type':'message_start','message':{**msg,'content':[],'stop_reason':None}})
   emit('content_block_start',{'type':'content_block_start','index':0,'content_block':{**c,'input':{}} if tool else {'type':'text','text':''}})
   emit('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps(c['input'])} if tool else {'type':'text_delta','text':c['text']}})
   emit('content_block_stop',{'type':'content_block_stop','index':0});emit('message_delta',{'type':'message_delta','delta':{'stop_reason':msg['stop_reason'],'stop_sequence':None},'usage':{'output_tokens':10}});emit('message_stop',{'type':'message_stop'})
  except Exception as e:
   fail.append(traceback.format_exc());(d/'handler-failure.txt').write_text('\n'.join(fail));self.send_response(500);self.end_headers();self.wfile.write(b'{}')
if mode=='unowned':
 gateway=subprocess.Popen(['node','--import',str(W/'node_modules/tsx/dist/loader.mjs'),str(Path(__file__).with_name('receiptInteractiveGateway.fixture.ts')),str(d)],cwd=W,env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'OPENCLAUDE_HOME':str(d),'NODE_ENV':'test'},stdin=subprocess.PIPE,stdout=(d/'gateway.stdout').open('wb'),stderr=(d/'gateway.stderr').open('wb'),start_new_session=True)
 deadline=time.monotonic()+40
 while not (d/'gateway-ready.json').exists():
  if gateway.poll() is not None or time.monotonic()>deadline:
   gateway.kill();gateway.wait();raise AssertionError('private Gateway readiness failed: '+(d/'gateway.stderr').read_text())
  time.sleep(.05)
 gateway_info=json.loads((d/'gateway-ready.json').read_text())
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();origin='http://127.0.0.1:'+str(server.server_port)
# Test-only outbound guard; no model/query/keyboard/owner replacement.
(d/'network-guard.ts').write_text("const realFetch=globalThis.fetch;globalThis.fetch=((input:any,opts:any)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);if(!"+json.dumps([origin]+(['http://127.0.0.1:'+str(gateway_info['port'])] if gateway_info else []))+".includes(url.origin)){Bun.write("+json.dumps(str(d/'blocked-network.txt'))+",url.origin+'\\n');throw new Error('D16 non-fixture outbound refused '+url.origin)}return realFetch(input,opts)}) as typeof fetch;\n")
bun=subprocess.check_output(['bash','-c','command -v bun'],text=True).strip()
args=json.loads(subprocess.check_output([bun,'-e',"import {getMacroDefines,DEFAULT_BUILD_FEATURES} from './scripts/defines.ts';console.log(JSON.stringify([...Object.entries({...getMacroDefines(),'process.env.NODE_ENV':JSON.stringify('production')}).flatMap(([k,v])=>['-d',k+':'+v]),...DEFAULT_BUILD_FEATURES.flatMap(x=>['--feature',x])]))"],cwd=W/'claude-code-best',text=True))
argv=[bun,'run',*args,'--preload',str(d/'network-guard.ts'),str(W/'claude-code-best/src/entrypoints/cli.tsx'),'--bare','--model','claude-sonnet-4-5-20250929','--dangerously-skip-permissions','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome']
env={'PATH':os.environ['PATH'],'HOME':str(d/'home'),'CLAUDE_CONFIG_DIR':str(d/'config'),'TMPDIR':str(d),'TERM':'xterm-256color','LANG':'C.UTF-8','ANTHROPIC_BASE_URL':origin,'ANTHROPIC_API_KEY':'synthetic-pty-only','ANTHROPIC_AUTH_TOKEN':'synthetic-pty-only','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CODE_DISABLE_AUTO_MEMORY':'1','CLAUDE_CODE_DISABLE_ATTACHMENTS':'1','CLAUDE_CODE_DISABLE_ADVISOR_TOOL':'1','DISABLE_TELEMETRY':'1','DISABLE_ERROR_REPORTING':'1','CLAUDE_CODE_MAX_RETRIES':'0','CLAUDE_CODE_UNATTENDED_RETRY':'0','NPM_CONFIG_OFFLINE':'true','ENABLE_SEARCH_EXTRA_TOOLS':'false','HTTP_PROXY':origin,'HTTPS_PROXY':origin,'ALL_PROXY':origin,'NO_PROXY':'127.0.0.1,localhost'}
if gateway_info:env.update({'OPENCLAUDE_HOME':str(d),'OPENCLAUDE_GATEWAY_PORT':str(gateway_info['port']),'OPENCLAUDE_GATEWAY_TOKEN_FILE':gateway_info['tokenFile'],'OPENCLAUDE_DELEGATE_CONTEXT_FILE':gateway_info['contextFile'],'OPENCLAUDE_RECEIPT_CALLER_V2':'1','OPENCLAUDE_DELEGATE_JOBS_DB':gateway_info['dbPath']})
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
def setup():
 os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
p=subprocess.Popen(argv,stdin=slave,stdout=slave,stderr=slave,cwd=d/'cwd',env=env,preexec_fn=setup);os.close(slave)
print('PRIVATE_DIR '+str(d),flush=True)
def drain():
 track()
 if select.select([master],[],[],.05)[0]:
  try:rawpty.extend(os.read(master,65536))
  except OSError:pass
 (d/'terminal.raw').write_bytes(rawpty)
def terminal_text():
 text=rawpty.decode(errors='replace');text=re.sub(r'\x1b\[\d+C',' ',text);text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',text);return re.sub(r'\s+',' ',text)
def until(check,label,seconds):
 end=time.monotonic()+seconds
 while not check():
  drain()
  if fail:raise AssertionError(fail[0])
  assert p.poll() is None,('CLI exited',p.returncode,rawpty[-3000:].decode(errors='replace'))
  assert time.monotonic()<end,(label,rawpty[-5000:].decode(errors='replace'))
error=None
try:
 # Real terminal initialization, then genuine terminal input, not argv -p.
 until(lambda:b'ANTHROPIC_API_KEY' in rawpty or b'pid:' in rawpty or b'Welcome back!' in rawpty,'interactive startup',60)
 if b'ANTHROPIC_API_KEY' in rawpty:
  os.write(master,b'\x1b[A\r') # real selection of the isolated synthetic key only
  until(lambda:b'pid:' in rawpty or b'Welcome back!' in rawpty,'interactive prompt after synthetic key approval',20)
 os.write(master,b'Run the private gated shell once and report its completion.')
 until(lambda:'Run the private gated shell once and report its completion.' in terminal_text(),'real terminal text entry',5)
 for _ in range(4): drain()
 os.write(master,b'\r')
 if mode=='unowned':
  until(done.is_set,'unowned receipt error reaches original model',20)
 else:
  until(lambda:(d/'started').exists(),'actual foreground shell start',30)
  until(lambda:b'ctrl+b' in rawpty.lower(),'original background keyboard affordance',10)
  if mode!='no-key':
   (d/'key-sent').write_text('actual PTY byte 02');os.write(master,b'\x02')
  deadline=time.monotonic()+5
  while time.monotonic()<deadline and not background.is_set():drain()
  observed={'background':background.is_set(),'mainModelRequests':sum(r['main'] for r in rows),'beforeRelease':not (d/'release').exists()}
  assert background.is_set(),'manually backgrounded tool_result must exist before release'
  (d/'release').write_text('released')
  until(done.is_set,'ordinary shell completion reaches next model',30)
 until(lambda:rawpty.count(b'D16_PTY_MODEL_DONE')>=1,'visible final model',5)
 os.write(master,b'\x04');
 for _ in range(30):
  if p.poll() is not None:break
  drain()
except Exception as e:error=repr(e);print('PROBE_FAILURE '+error,flush=True)
finally:
 track()
 (d/'release').write_text('cleanup')
 try:os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError:pass
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
 try:os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 drain();os.close(master);server.shutdown();server.server_close()
 if gateway:
  try:
   gateway.stdin.write(b'exit\n');gateway.stdin.flush();gateway.wait(timeout=10);assert gateway.returncode==0
  except Exception as e:
   error=error or 'gateway cleanup '+repr(e);gateway.kill();gateway.wait()
 try:reap_owned()
 except Exception as e:error=error or repr(e)
 evidence={'mode':mode,'observedBeforeCleanup':observed,'private':str(d),'argv':argv,'mainModelRequests':sum(r['main'] for r in rows),'allRequests':len(rows),'keySent':(d/'key-sent').exists(),'background':background.is_set(),'modelReceivedOrdinaryResult':done.is_set() and mode=='ordinary','modelReceivedUnownedError':done.is_set() and mode=='unowned','error':error,'handlerFailures':fail,'exit':p.returncode,'networkGuard':'Bun fetch fixture-origin only; explicit env allowlist; no namespace claim','receiptOwner':'none; ordinary interactive compatibility only'}
 (d/'evidence.json').write_text(json.dumps(evidence,indent=2));print(json.dumps(evidence),flush=True)
 if error or fail:sys.exit(1)
