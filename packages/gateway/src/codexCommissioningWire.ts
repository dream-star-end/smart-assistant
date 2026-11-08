import type { Readable } from 'node:stream'
/** Bound each frame BEFORE parsing; EOF and malformed/oversized frames close the admission. */
export function commissioningLines(stream: Readable, accept:(v:any)=>void, failure:(e:Error)=>void):void {
  const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',closed=false
  const fail=(e:unknown)=>{if(!closed){closed=true;failure(e instanceof Error?e:new Error('COMMISSION_WIRE_INVALID'))}}
  stream.on('data',(chunk:Buffer)=>{if(closed)return;try{
    buffer+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(buffer)>3*1024*1024)throw new Error('COMMISSION_WIRE_LIMIT')
    while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);accept(JSON.parse(line))}
  }catch(e){fail(e)}})
  stream.once('error',fail);stream.once('end',()=>fail(new Error('COMMISSION_WIRE_EOF')))
}
