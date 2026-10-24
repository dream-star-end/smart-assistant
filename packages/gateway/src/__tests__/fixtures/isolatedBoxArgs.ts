/** Fixture namespace rewrite, limited to executable code and absolute path arguments, never payloads. */
import { isAbsolute } from 'node:path'
const BOX_HOME = '/home/box/.claude'
export function isolatedBoxArgs(args: readonly string[], syntheticBoxHome: string, depth = 0): string[] {
  if (depth > 4 || !isAbsolute(syntheticBoxHome) || syntheticBoxHome === '/' || syntheticBoxHome.startsWith('/home/') || args[0] !== '-I' || args[1] !== '-c' || !args[2]) throw new Error('invalid isolated Python fixture')
  const components = syntheticBoxHome.split('/').filter(Boolean).map(v => JSON.stringify(v))
  const tuple = (parts: string[]) => `(${parts.join(',')},)`
  const rewriteProgram = (program: string): string => program
    .replaceAll("('home','box','.claude','projects')", tuple([...components, '"projects"']))
    .replaceAll("('home','box','.claude')", tuple(components))
    .replaceAll(BOX_HOME, syntheticBoxHome)
  const result = [...args]
  result[2] = rewriteProgram(args[2])
  for (let i = 3; i < result.length; i++) {
    const arg = result[i] ?? ''
    if (arg === BOX_HOME || arg.startsWith(`${BOX_HOME}/`)) result[i] = syntheticBoxHome + arg.slice(BOX_HOME.length)
  }
  // guardBoxPrivateStage puts exactly one executable program here. Later base64 arguments
  // are transcript/system/tool bytes with their original hashes and must stay untouched.
  if (args[2].includes('nonce,want,encoded,*argv=sys.argv[1:]')) {
    const encoded = args[5] ?? ''
    const bytes = Buffer.from(encoded, 'base64')
    if (!encoded || bytes.toString('base64') !== encoded || bytes.length > 16_384) throw new Error('invalid guarded fixture program')
    result[5] = Buffer.from(rewriteProgram(bytes.toString('utf8'))).toString('base64')
  }
  if (args[2].includes('steps=json.loads(raw)') && args[2].includes("subprocess.run(['/usr/bin/python3',*argv]")) {
    const encoded = args[3] ?? ''
    const bytes = Buffer.from(encoded, 'base64')
    if (!encoded || bytes.toString('base64') !== encoded || bytes.length > 49_152) throw new Error('invalid fixture batch')
    const steps: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 16 || steps.some(step => !Array.isArray(step) || step.some(v => typeof v !== 'string'))) throw new Error('invalid fixture batch steps')
    result[3] = Buffer.from(JSON.stringify(steps.map(step => isolatedBoxArgs(step, syntheticBoxHome, depth + 1)))).toString('base64')
  }
  return result
}
