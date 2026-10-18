import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root=mkdtempSync('/tmp/ocv5-501-contract-');mkdirSync(`${root}/work`);
const hint=`OC_RETRY_HINT_V1:${Buffer.from(JSON.stringify({status:429,retryNotBeforeMs:Date.now()+3500})).toString('base64url')}`;
const arms=[];
const fixturePrompt='fixture request';
const fixtureContinuation='fixture continuation';
function userTextContents(request){
 return request.messages.filter(message=>message.role==='user').flatMap(message=>{
  if(typeof message.content==='string')return[message.content];
  return Array.isArray(message.content)?message.content.filter(block=>block.type==='text').map(block=>block.text):[];
 });
}
// CLI may coalesce adjacent user messages or append a newline. Require every
// original text byte sequence to survive in order without trimming/rewrite.
function hasOrderedExactUserText(originalChunks,resumedChunks){
 const haystack=Buffer.concat(resumedChunks.map(text=>Buffer.from(text,'utf8')));
 let cursor=0;
 for(const text of originalChunks){
  const needle=Buffer.from(text,'utf8');
  const offset=haystack.indexOf(needle,cursor);
  if(offset<0)return false;
  cursor=offset+needle.length;
 }
 return true;
}
// Local guard examples: coalescing is valid; losing a task or reversing the
// original chunk order must still fail before any isolated HTTP/CLI fixture.
assert.equal(hasOrderedExactUserText(
 [fixturePrompt,fixtureContinuation],[`${fixturePrompt}\n${fixtureContinuation}\n`]),true);
assert.equal(hasOrderedExactUserText([fixturePrompt],[fixtureContinuation]),false);
assert.equal(hasOrderedExactUserText(
 [fixturePrompt,fixtureContinuation],[`${fixtureContinuation}\n${fixturePrompt}\n`]),false);
for(const name of ['control','hint','missing-egress']){
 const home=`${root}/${name}`;mkdirSync(home);mkdirSync(`${home}/cache`);mkdirSync(`${home}/config`);
 const captured=[];
 let egressConfigured=false;
 const status=name==='missing-egress'?409:429;
 const message=name==='hint'?`upstream rate limited; ${hint}`:name==='missing-egress'?'BOX_EGRESS_NOT_CONFIGURED':'upstream rate limited';
 const server=createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'});res.end('{"input_tokens":100}');return;}
  captured.push(JSON.parse(raw));
  if(captured.length===1||(name==='missing-egress'&&!egressConfigured)){res.writeHead(status,{'content-type':'application/json','retry-after':'1'});
   res.end(JSON.stringify({error:{code:name==='missing-egress'?'BOX_EGRESS_NOT_CONFIGURED':'UPSTREAM_RATE_LIMITED',message},request_id:'fixture-request'}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  const rows=[['message_start',{type:'message_start',message:{id:'fixture-msg',type:'message',role:'assistant',model:'glm-5.3-zai',content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}}],
   ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}}],['content_block_stop',{type:'content_block_stop',index:0}],
   ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}}],['message_stop',{type:'message_stop'}]];
  res.end(rows.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 async function run(prompt,resume){
  const args=['-p',prompt,'--output-format','stream-json','--verbose','--model','glm-5.3-zai','--tools','','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands'];
  if(resume)args.push('--resume',resume);
  const child=spawn('/usr/local/bin/claude',args,{cwd:`${root}/work`,env:{HOME:home,TMPDIR:'/tmp',XDG_CACHE_HOME:`${home}/cache`,CLAUDE_CONFIG_DIR:`${home}/config`,
   PATH:'/usr/bin:/bin:/usr/local/bin',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_AUTH_TOKEN:'fixture-only-not-a-real-key',
   CLAUDE_CODE_MAX_RETRIES:'0',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['ignore','pipe','pipe']});
  let out='';
  let errBytes=0;child.stdout.on('data',x=>{out+=x;if(out.length>2000000)child.kill('SIGKILL')});child.stderr.on('data',x=>{errBytes+=x.length;if(errBytes>200000)child.kill('SIGKILL')});
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}))});clearTimeout(timer);
  const terminal=out.trim().split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}).filter(x=>x.type==='result').at(-1);
  return {exit,terminal,stderrBytes:errBytes};
 }
 const first=await run(fixturePrompt);
 assert.equal(first.terminal?.is_error,true,`${name} terminal`);assert.equal(first.terminal.api_error_status,status);
 assert.equal(captured.length,1,`${name} must send one HTTP request before repair or retry`);
 const sessionId=first.terminal.session_id;
 assert.ok(typeof sessionId==='string'&&sessionId.length>0,`${name} original session missing`);
 if(name==='hint')assert.ok(JSON.stringify(first.terminal).includes(hint));
 if(name==='missing-egress'){
  assert.ok(JSON.stringify(first.terminal).includes('BOX_EGRESS_NOT_CONFIGURED'));
  // Simulate an explicitly authorized out-of-band configuration repair, not an automatic retry.
  egressConfigured=true;
 }
 const before=captured.length;
 const second=await run(fixtureContinuation,sessionId);
 assert.equal(second.exit.code,0,`${name} resumed CLI exit`);
 assert.equal(second.terminal?.is_error,false,`${name} resumed terminal`);
 assert.equal(second.terminal.result,'ok',`${name} resumed task response missing`);
 assert.equal(second.terminal.session_id,sessionId,`${name} changed native session during resume`);
 assert.equal(captured.length,2,`${name} must send exactly one failed and one resumed HTTP POST`);
 const resumed=captured.slice(before);
 const forbidden=['OC_RETRY_HINT_V1','BOX_EGRESS_NOT_CONFIGURED','UPSTREAM_RATE_LIMITED','upstream rate limited','API Error:'];
 for(const request of resumed){
  const upstream=JSON.stringify({system:request.system,tools:request.tools,messages:request.messages});
  for(const marker of forbidden)assert.ok(!upstream.includes(marker),`${name} API diagnostic leaked into resumed input: ${marker}`);
 }
 const request=resumed.find(r=>r.model==='glm-5.3-zai'&&JSON.stringify(r.messages).includes(fixtureContinuation));
 assert.ok(request,`${name} main resumed request missing`);
 const originalUserText=userTextContents(captured[0]);
 const resumedUserText=userTextContents(request);
 assert.ok(resumedUserText.some(text=>text.includes(fixtureContinuation)),`${name} continuation input missing`);
 assert.ok(originalUserText.some(text=>text.includes(fixturePrompt)),`${name} original task missing from first request`);
 assert.ok(resumedUserText.some(text=>text.includes(fixturePrompt)),`${name} original task missing from resumed request`);
 assert.ok(hasOrderedExactUserText(originalUserText,resumedUserText),`${name} lost or reordered exact original user-task text during resume`);
 arms.push({name,httpPosts:captured.length,status,terminalRetainsHint:name==='hint',terminalRetainsCode:name==='missing-egress',
  repairedAfterFailure:name==='missing-egress',resumedSameSession:true,originalTaskContextPreserved:true,
  hintAbsentFromResumedPrompt:true,apiErrorsAbsentFromResumedPrompt:true,
  prefixSha256:createHash('sha256').update(JSON.stringify({system:request.system,tools:request.tools})).digest('hex'),
  messagesSha256:createHash('sha256').update(JSON.stringify(request.messages)).digest('hex'),
  resumedRequest:request,firstApiStatus:first.terminal.api_error_status});
 server.closeAllConnections();await new Promise(r=>server.close(r));
}
const [control,withHint,missingEgress]=arms;
for(const arm of [withHint,missingEgress]){
 assert.deepEqual(arm.resumedRequest.system,control.resumedRequest.system,`${arm.name} changed system prefix`);
 assert.deepEqual(arm.resumedRequest.tools,control.resumedRequest.tools,`${arm.name} changed tool schema`);
 assert.deepEqual(arm.resumedRequest.messages,control.resumedRequest.messages,`${arm.name} changed resumed model history`);
}
console.log(JSON.stringify({claudeVersion:'2.1.302',network:'none; loopback only',realUpstreamRequests:0,
 fullPromptAndHistoryEqual:true,missingEgressRepairedAndResumed:true,originalTaskContextPreserved:true,
 contextGuardNegativeExamplesPass:true,
 arms:arms.map(({resumedRequest,...safe})=>safe)},null,2));
