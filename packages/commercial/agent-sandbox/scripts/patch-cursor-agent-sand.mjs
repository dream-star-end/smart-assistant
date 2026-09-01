#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SAND_PATCH_MARKER = 'OPENCLAUDE_SCOPED_SAND_V1'

const CLIENT_HEADER = 's.header.set("x-cursor-client-version",`cli-${h}${A}`),s.header.set("x-cursor-client-type",m)'
const SCOPED_HEADER = [
  '(()=>{',
  'const e=process.env.OPENCLAUDE_CURSOR_SAND_MODE==="1"&&!!(',
  's.service&&/(?:ChatService|InferenceService|AiService)/.test(s.service.typeName||"")',
  '||s.method&&/(?:ChatService|InferenceService|AiService)/.test(s.method.name||"")',
  '||s.url&&/(?:InferenceService|GetSandUsageStatus|\\/Stream)/.test(s.url)',
  ');',
  's.header.set("x-cursor-client-version",e?(process.env.OPENCLAUDE_CURSOR_SAND_CLIENT_VERSION||"0.30.0"):`cli-${h}${A}`),',
  'e&&s.header.set("x-sand-box-namespace","prod"),',
  's.header.set("x-cursor-client-type",e?"sand":m)',
  `})()/*${SAND_PATCH_MARKER}*/`,
].join('')

export function patchCursorAgentSource(source) {
  if (source.includes(SAND_PATCH_MARKER)) throw new Error('Cursor Agent Sand patch already present')
  const count = source.split(CLIENT_HEADER).length - 1
  if (count !== 1) throw new Error(`Cursor Agent Sand patch anchor count=${count}`)
  const patched = source.replace(CLIENT_HEADER, SCOPED_HEADER)
  if (!patched.includes(SAND_PATCH_MARKER)) throw new Error('Cursor Agent Sand patch marker missing')
  return patched
}

export function patchCursorAgentInstall(installRoot) {
  const root = resolve(installRoot)
  const indexPath = join(root, 'index.js')
  const markerPath = join(root, '.openclaude-scoped-sand-v1')
  const source = readFileSync(indexPath, 'utf8')
  const patched = patchCursorAgentSource(source)
  const temporary = `${indexPath}.openclaude-tmp`
  writeFileSync(temporary, patched, { mode: 0o444 })
  renameSync(temporary, indexPath)
  chmodSync(indexPath, 0o444)
  const digest = createHash('sha256').update(patched).digest('hex')
  writeFileSync(markerPath, `${SAND_PATCH_MARKER} ${digest}\n`, { mode: 0o444 })
  chmodSync(markerPath, 0o444)
  return { indexPath, markerPath, digest }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : ''
if (invoked === fileURLToPath(import.meta.url)) {
  const installRoot = process.argv[2]
  if (!installRoot) throw new Error('usage: patch-cursor-agent-sand.mjs INSTALL_ROOT')
  const result = patchCursorAgentInstall(installRoot)
  process.stdout.write(`patched Cursor Agent Sand scope sha256=${result.digest}\n`)
}
