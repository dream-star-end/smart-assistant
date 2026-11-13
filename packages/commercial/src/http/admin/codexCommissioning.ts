import type { IncomingMessage,ServerResponse } from 'node:http'
import { requireAdminVerifyDb } from '../../admin/requireAdmin.js'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import type { CommercialHttpDeps,RequestContext } from '../handlers.js'
import { HttpError,readJsonBody,sendJson } from '../util.js'
export async function handleCodexCommissioning(req:IncomingMessage,res:ServerResponse,ctx:RequestContext,deps:CommercialHttpDeps){
  const admin=await requireAdminVerifyDb(req,deps.jwtSecret)
  if(String(admin.id)!=='3')throw new HttpError(403,'FORBIDDEN','commissioning is restricted to selfhost admin uid3')
  const service=deps.codexCommissioning
  if(!service)throw new HttpError(503,'UNAVAILABLE','commissioning requires the selfhost master with signed model authority')
  const path=new URL(req.url??'/','http://localhost').pathname
  const m=/^\/api\/admin\/remote-pool\/codex-commissioning(?:\/([a-f0-9-]{36})(?:\/(artifact|apply|revoke))?)?$/.exec(path)
  if(!m)throw new HttpError(404,'NOT_FOUND','unknown commissioning action')
  try{
    let result:unknown
    if(req.method==='GET'&&m[1])result=m[2]==='artifact'?service.artifact(m[1]):!m[2]?service.status(m[1]):undefined
    else if(req.method==='POST'){
      const body=await readJsonBody(req) as any
      if(!m[1]){if(!body||typeof body.profileId!=='string'||!/^[a-f0-9-]{36}$/.test(body.profileId))throw new Error('CODEX_COMMISSION_PROFILE_REQUIRED');result=await service.start(String(admin.id),body.profileId)}
      else if(m[2]==='apply'||m[2]==='revoke')result=await service[m[2]](m[1],body?.e2eReceiptSha256,body?.confirm===true)
    }
    if(result===undefined)throw new HttpError(404,'NOT_FOUND','unknown commissioning action')
    await writeAdminAuditBestEffort({adminId:admin.id,ip:ctx.clientIp,userAgent:ctx.userAgent},'remote_pool.codex_commissioning',m[1]??'new',null,{method:req.method,action:m[2]??(m[1]?'status':'run')})
    sendJson(res,req.method==='POST'&&!m[1]?202:200,result)
  }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(409,'CONFLICT',e instanceof Error&&/^CODEX_[A-Z_]+$/.test(e.message)?e.message:'CODEX_COMMISSION_REJECTED')}
}
