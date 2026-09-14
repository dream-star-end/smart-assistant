/** Private real Gateway with empty real SessionManager. No parent/SDK/owner fixture. */
import {randomBytes} from 'node:crypto'
import {createServer} from 'node:http'
import {createInterface} from 'node:readline'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import {Gateway} from '../../server.js'
import {DelegateDurableDb} from '../../delegateDurable.js'
import {DelegateJobStore} from '../../delegateJobs.js'
import {issueDelegateContextToken} from '../../delegateContext.js'
const dir=process.argv[2]!;assert.ok(dir)
const token=randomBytes(32).toString('hex'),session='agent:main:webchat:dm:unowned-interactive'
const dbPath=join(dir,'delegate-jobs.db'),db=new DelegateDurableDb(dbPath)
const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true})
const gw=new Gateway({config:{version:1,gateway:{bind:'127.0.0.1',port:0,accessToken:token},
 auth:{mode:'subscription',claudeCodePath:''},sessions:{dbPath:join(dir,'sessions.db')},
 defaults:{model:'claude-sonnet-4-5-20250929',permissionMode:'default'},channels:{webchat:{enabled:true}}} as never,
 agentsConfig:{agents:[{id:'main',model:'claude-sonnet-4-5-20250929'}],routes:[],default:'main'}})
;(gw as any)._delegateJobs=jobs
assert.equal((gw as any).sessions.getByKey(session),undefined)
const requests:Array<{path:string;status:number}>=[]
const server=createServer((req,res)=>{res.on('finish',()=>requests.push({path:req.url||'',status:res.statusCode}));try{(gw as any).handleHttp(req,res)}catch(e){process.stderr.write(String(e));process.exitCode=1;res.destroy()}})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
const tokenFile=join(dir,'gateway-token'),contextFile=join(dir,'gateway-context')
writeFileSync(tokenFile,token,{mode:0o600})
// Real private process issuer; signature is valid but intentionally no registered parent.
writeFileSync(contextFile,issueDelegateContextToken({agentId:'main',sessionKey:session,depth:0}),{mode:0o600})
writeFileSync(join(dir,'gateway-ready.json'),JSON.stringify({port:(server.address() as {port:number}).port,dbPath,tokenFile,contextFile}))
const input=createInterface({input:process.stdin})
input.once('line',async()=>{
 try{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))
  assert.equal((gw as any).sessions.getByKey(session),undefined)
  const jobsCount=(db as any).db.prepare('SELECT count(*) n FROM delegate_jobs').get().n
  const receipts=(db as any).db.prepare('SELECT count(*) n FROM delegate_delivery_receipt').get().n
  assert.equal(jobsCount,0);assert.equal(receipts,0)
  assert.equal(requests.length,4);assert.ok(requests.every(r=>r.path==='/api/delegate/receipt-owner/issue'&&r.status===409))
  writeFileSync(join(dir,'gateway-evidence.json'),JSON.stringify({passed:true,requests,jobs:jobsCount,receipts,parents:0}))
  jobs.close();input.close();process.stdin.destroy()
 }catch(e){console.error(e);process.exit(1)}
})
