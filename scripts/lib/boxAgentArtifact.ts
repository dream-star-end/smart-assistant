/** Provenance for the production CCB executable used by the real Agent proof. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type FileIdentity = [path: string, sha256: string, mode: string]
const RECEIPT = '.box-agent-proof-artifact.json'
const shared = ['packages/storage/src/sessionFileIo.ts', 'packages/protocol/src/contextBytePressure.ts',
  'packages/gateway/src/engine/contextReference.ts']
function identity(root: string, path: string): FileIdentity {
  return [relative(root,path).split('\\').join('/'),
    createHash('sha256').update(readFileSync(path)).digest('hex'), (statSync(path).mode & 0o777).toString(8)]
}
function files(root: string, directory: string, exclude: ReadonlySet<string>): FileIdentity[] {
  const rows: FileIdentity[]=[]
  const visit=(dir:string) => {
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      if(exclude.has(entry.name)) continue
      const path=join(dir,entry.name)
      if(entry.isDirectory()) visit(path)
      else if(entry.isFile()) rows.push(identity(root,path))
    }
  }
  visit(directory)
  return rows.sort((a,b) => a[0]<b[0] ? -1 : a[0]>b[0] ? 1 : 0)
}
function sourceFiles(root:string):FileIdentity[] {
  return [...files(root,join(root,'claude-code-best'),new Set(['node_modules','dist','.git'])),
    ...shared.map(path => identity(root,join(root,path)))].sort((a,b) => a[0]<b[0] ? -1 : a[0]>b[0] ? 1 : 0)
}
const digest=(value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function recordBoxAgentArtifact(root:string,bunVersion:string,ccbDistKey:string):void {
  if(!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(bunVersion) || !/^[a-f0-9]{12}$/.test(ccbDistKey)) {
    throw new Error('BOX_AGENT_ARTIFACT_BUILD_IDENTITY_INVALID')
  }
  const source=sourceFiles(root),dist=files(root,join(root,'claude-code-best/dist'),new Set())
  if(!dist.some(([path]) => path === 'claude-code-best/dist/cli.js')) throw new Error('BOX_AGENT_ARTIFACT_ENTRY_MISSING')
  writeFileSync(join(root,RECEIPT),JSON.stringify({version:1,bunVersion,ccbDistKey,
    productionProfile:true,sourceDigest:digest(source),source,distDigest:digest(dist),dist},null,2)+'\n',{mode:0o600})
}
export function verifiedBoxAgentEntry(root:string):string {
  const value=JSON.parse(readFileSync(join(root,RECEIPT),'utf8')) as Record<string,unknown>
  if(value.version !== 1 || value.productionProfile !== true
    || digest(sourceFiles(root)) !== value.sourceDigest
    || digest(files(root,join(root,'claude-code-best/dist'),new Set())) !== value.distDigest) {
    throw new Error('BOX_AGENT_ARTIFACT_SOURCE_OR_DIST_MISMATCH')
  }
  return join(root,'claude-code-best/dist/cli.js')
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv.length !== 6 || process.argv[2] !== '--record') throw new Error('usage: boxAgentArtifact.ts --record <candidate> <bunVersion> <ccbDistKey>')
  recordBoxAgentArtifact(resolve(process.argv[3]!),process.argv[4]!,process.argv[5]!)
}
