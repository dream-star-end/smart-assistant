import { constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,writeFileSync } from 'node:fs'
import { join,dirname,isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { requireCommission } from './codexCommissioningStore.js'
export const evidenceHash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
export class CommissionEvidence {
  constructor(readonly root:string){
    requireCommission(process.getuid?.()===0,'ROOT_REQUIRED')
    requireCommission(isAbsolute(root),'EVIDENCE_ABSOLUTE')
    mkdirSync(root,{recursive:true,mode:0o700})
    for(let p=dirname(root);p!=='/';p=dirname(p)){const a=lstatSync(p);requireCommission(a.isDirectory()&&!a.isSymbolicLink()&&a.uid===0&&!(a.mode&0o022),'UNSAFE_EVIDENCE_ANCESTOR')}
    const s=lstatSync(root);requireCommission(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o077),'UNSAFE_EVIDENCE_ROOT')
  }
  dir(id:string):string{requireCommission(/^[a-f0-9-]{36}$/.test(id),'RUN_ID');return join(this.root,id)}
  create(id:string){mkdirSync(this.dir(id),{mode:0o700})}
  write(id:string,name:string,v:unknown,replace=false){
    requireCommission(/^[a-z-]+\.json$/.test(name),'FILE_NAME');const path=join(this.dir(id),name),tmp=replace?path+'.tmp':path
    const fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try{writeFileSync(fd,JSON.stringify(v));fsyncSync(fd)}finally{closeSync(fd)}
    if(replace)renameSync(tmp,path)
    const d=openSync(this.dir(id),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(d)}finally{closeSync(d)}
  }
  read(id:string,name:string):any{
    requireCommission(/^[a-z-]+\.json$/.test(name),'FILE_NAME');return JSON.parse(this.bytes(join(this.dir(id),name)).toString('utf8'))
  }
  bytes(path:string):Buffer{
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
    try{const s=fstatSync(fd);requireCommission(s.isFile()&&s.uid===0&&s.nlink===1&&!(s.mode&0o077)&&s.size<=16*1024*1024,'UNSAFE_EVIDENCE');return readFileSync(fd)}finally{closeSync(fd)}
  }
  frames(id:string){const dir=join(this.dir(id),'relay');return readdirSync(dir).sort().map(name=>{
    requireCommission(/^\d{8}-[a-z-]+\.json$/.test(name),'FRAME_NAME');const data=this.bytes(join(dir,name));return {name,sha256:evidenceHash(data),bytes:data.length}
  })}
}
