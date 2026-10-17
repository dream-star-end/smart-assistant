#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SAND_PATCH_MARKER = 'OPENCLAUDE_SCOPED_SAND_V1'

// The CLI's connect interceptor sets the client version and type back to back on
// the outgoing request. Minified names change between builds (2026.08.11 used
// `s`/`cli-${h}${A}`/`m`; 2026.10.16 uses `i`/`cli-2026.10.16-e3cb207${m}`/`l`),
// so the anchor captures the request, version template and client-type names
// instead of hard-coding them. It must still match exactly once.
const CLIENT_HEADER = /([A-Za-z_$][\w$]*)\.header\.set\("x-cursor-client-version",(`cli-[^`]*`)\),\1\.header\.set\("x-cursor-client-type",([A-Za-z_$][\w$]*)\)/g

function scopedHeader(req, version, type) {
  const e = req === 'e' || type === 'e' ? '$oc' : 'e'
  return [
    '(()=>{',
    `const ${e}=process.env.OPENCLAUDE_CURSOR_SAND_MODE==="1"&&!!(`,
    `${req}.service&&/(?:ChatService|InferenceService|AiService)/.test(${req}.service.typeName||"")`,
    `||${req}.method&&/(?:ChatService|InferenceService|AiService)/.test(${req}.method.name||"")`,
    `||${req}.url&&/(?:InferenceService|GetSandUsageStatus|\\/Stream)/.test(${req}.url)`,
    ');',
    `${req}.header.set("x-cursor-client-version",${e}?(process.env.OPENCLAUDE_CURSOR_SAND_CLIENT_VERSION||"0.30.0"):${version}),`,
    `${e}&&${req}.header.set("x-sand-box-namespace","prod"),`,
    `${req}.header.set("x-cursor-client-type",${e}?"sand":${type})`,
    `})()/*${SAND_PATCH_MARKER}*/`,
  ].join('')
}

export function patchCursorAgentSource(source) {
  if (source.includes(SAND_PATCH_MARKER)) throw new Error('Cursor Agent Sand patch already present')
  const matches = [...source.matchAll(CLIENT_HEADER)]
  if (matches.length !== 1) throw new Error(`Cursor Agent Sand patch anchor count=${matches.length}`)
  const [anchor, req, version, type] = matches[0]
  const patched = source.slice(0, matches[0].index)
    + scopedHeader(req, version, type)
    + source.slice(matches[0].index + anchor.length)
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
