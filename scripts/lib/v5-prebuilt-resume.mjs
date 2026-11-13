// Read-only historical build evidence. Current live gates are never inferred here.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const canonical = '/opt/openclaude/openclaude-v5-aurora'
const sha40 = /^[a-f0-9]{40}$/
const sha64 = /^[a-f0-9]{64}$/
const fail = message => { throw new Error(`prebuilt resume: ${message}`) }
const need = (condition, message) => { if (!condition) fail(message) }
const hash = value => createHash('sha256').update(value).digest('hex')

export function validateOriginBuildEvidence(input) {
  const { sourceCommit, originUnit, masterRelease, runtimeRelease, imageId, masterMarker } = input
  need(sha40.test(sourceCommit), 'invalid source SHA')
  need(new RegExp(`^openclaude-v5-deploy-[0-9]{8}-[0-9]{6}-${sourceCommit.slice(0, 8)}-with-dist\\.service$`).test(originUnit), 'wrong original unit')
  const roots = input.releaseRoots ?? { master: '/opt/openclaude/openclaude-v5-releases', runtime: '/var/lib/openclaude-v5/runtime-releases' }
  const masterName = masterRelease?.slice(roots.master.length + 1)
  need(masterRelease?.startsWith(`${roots.master}/`) && /^rel-[a-f0-9]{7,40}-[0-9]{8}-[0-9]{6}$/.test(masterName), 'invalid master path')
  need(runtimeRelease?.startsWith(`${roots.runtime}/`) && /^rel-[a-f0-9]{12}$/.test(runtimeRelease.slice(roots.runtime.length + 1)), 'invalid runtime path')
  need(/^sha256:[a-f0-9]{64}$/.test(imageId), 'invalid image ID')
  need(masterMarker?.schemaVersion === 2 && masterMarker.sourceCommit === sourceCommit && sha64.test(masterMarker.artifactSha256) && sha64.test(masterMarker.metadataSha256), 'untrusted master marker')
  need(masterName === `rel-${masterName.split('-')[1]}-${masterMarker.builtAt}` && sourceCommit.startsWith(masterName.split('-')[1]), 'marker/path/source mismatch')
  let props = input.unitProperties
  if (typeof props === 'string') props = Object.fromEntries(props.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  need(props && (!props.Id || props.Id === originUnit) && /^[a-f0-9]{32}$/.test(props.InvocationID ?? ''), 'missing original invocation')
  need(props.ActiveState === 'failed' && props.SubState === 'failed' && props.Result === 'exit-code' && String(props.ExecMainStatus) === '1', 'original unit is not a completed failed invocation')
  need(props.WorkingDirectory === canonical, 'original unit cwd mismatch')
  need(typeof props.ExecStart === 'string' && props.ExecStart.split('argv[]=').length === 2 && props.ExecStart.includes(`path=/usr/bin/bash ; argv[]=/usr/bin/bash ${canonical}/scripts/deploy-v5.sh --with-dist ; ignore_errors=no ;`), 'original unit was not exact ordinary --with-dist')
  const start = Date.parse(props.ExecMainStartTimestamp), end = Date.parse(props.ExecMainExitTimestamp)
  const compact = /^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$/.exec(masterMarker.builtAt ?? '')
  const built = compact ? Date.parse(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`) : NaN
  need(Number.isFinite(start) && Number.isFinite(end) && start < end && start <= built && built <= end, 'artifact outside original invocation')
  let rows = input.journal
  if (typeof rows === 'string') rows = rows.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  need(Array.isArray(rows) && rows.length > 0 && rows.length <= 200000, 'missing bounded original journal')
  const events = rows.filter(row => row._SYSTEMD_INVOCATION_ID === props.InvocationID).map(row => ({ at: Number(row.__REALTIME_TIMESTAMP) / 1000, message: row.MESSAGE }))
  need(events.every(event => Number.isFinite(event.at) && typeof event.message === 'string' && event.at >= start && event.at <= end + 1000), 'invalid journal timestamps')
  need(events.every((event, index) => index === 0 || event.at >= events[index - 1].at), 'original journal is not chronological')
  const find = (message, after = -1) => events.findIndex((event, index) => index > after && event.message === message)
  const master = find(`  ✓ release 就绪(带 .complete):${masterRelease}`)
  const runtime = find(`  ✓ runtime release=${runtimeRelease} image_id=${imageId}`, master)
  const stopped = find('✗ 未证明商业空窗,live 未切换', runtime)
  need(master >= 0 && runtime > master && stopped > runtime, 'incomplete/foreign build or non-idle failure')
  if (input.platformBundle !== undefined) {
    need(/^[a-f0-9]{12}$/.test(input.platformBundle), 'invalid platform bundle')
    const bundle = find(`  ✓ platform bundle rev=${input.platformBundle}`, master)
    need(bundle > master && bundle < runtime, 'original invocation did not build/select this platform bundle')
  }
  need(!events.some(event => /✓ deploy 完成|── 激活 openclaude-v5-egress|开始 source\/DB 对称补偿/.test(event.message)), 'original invocation passed activation boundary')
  const predecessor = events.map(event => /捕获 predecessor\(kind=strong path=([^\)]+)\)/.exec(event.message)?.[1]).find(Boolean)
  const lane = events.map(event => /active lane: slot=([AB]) .*state_lock=([0-9]+)/.exec(event.message)).find(Boolean)
  return { schemaVersion: 1, sourceCommit, originUnit, invocationId: props.InvocationID,
    journalSha256: hash(JSON.stringify({ start, end, exec: props.ExecStart.split(' ; ignore_errors=')[0], events })),
    masterRelease, runtimeRelease, imageId, masterArtifactSha256: masterMarker.artifactSha256,
    originPredecessor: predecessor ?? null, originSlot: lane?.[1] ?? null, originStateLock: lane?.[2] ?? null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [recordPath, propertiesPath, journalPath, markerPath, masterRoot, runtimeRoot] = process.argv.slice(2)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    const result = validateOriginBuildEvidence({ ...record,
      releaseRoots: { master: masterRoot, runtime: runtimeRoot },
      unitProperties: readFileSync(propertiesPath, 'utf8'), journal: readFileSync(journalPath, 'utf8'),
      masterMarker: JSON.parse(readFileSync(markerPath, 'utf8')) })
    console.log(JSON.stringify(result))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
