/**
 * Remote driver v4 upstream model alias & node default driverContext resolution (`OCV5-749`, R12).
 */
import { loadBoxBridgeMod } from '@openclaude/gateway'
import type { RemoteProbeSnapshot } from '@openclaude/protocol'

export interface DefaultDriverContextForNodeInput {
  readonly driverId: string
  readonly sshUser: string
  readonly profileName: string
  readonly controllerSha256: string
  readonly cliVersion?: string | null
  readonly includeBridgeFiles?: boolean
}

export function resolveProbedUpstreamModel(
  driverId: string,
  rawUpstreamModelId: string,
  snapshot: RemoteProbeSnapshot,
): string | null {
  if (snapshot.models.some((m) => m.upstreamModelId === rawUpstreamModelId)) {
    return rawUpstreamModelId
  }
  if (driverId === 'cc') {
    if (
      /^claude-sonnet-/.test(rawUpstreamModelId) &&
      snapshot.models.some((m) => m.upstreamModelId === 'sonnet')
    ) {
      return 'sonnet'
    }
    if (
      /^claude-haiku-/.test(rawUpstreamModelId) &&
      snapshot.models.some((m) => m.upstreamModelId === 'haiku')
    ) {
      return 'haiku'
    }
    if (
      /^claude-opus-/.test(rawUpstreamModelId) &&
      snapshot.models.some((m) => m.upstreamModelId === 'opus')
    ) {
      return 'opus'
    }
  }
  if (driverId === 'antigravity') {
    const slug = rawUpstreamModelId.trim().toLowerCase().replace(/-remote$/, '')
    const candidates: string[] = []
    if (slug === 'antigravity-orchestrator-carbon' || slug === 'gemini-pro-orchestrator') {
      candidates.push('gemini-pro-orchestrator')
    } else if (slug === 'antigravity-orchestrator-neon' || slug === 'gemini-pro-orchestrator-neon') {
      candidates.push('gemini-pro-orchestrator-neon')
    } else {
      const bare = slug.replace(/^antigravity-/, '').replace(/5\.5$/, '5-5')
      const base = bare.replace(/-(?:low|medium|high|xhigh|max)$/, '')
      candidates.push(bare, `${bare}-medium`, `${bare}-high`, base, `${base}-medium`, `${base}-high`)
    }
    for (const cand of candidates) {
      if (snapshot.models.some((m) => m.upstreamModelId === cand)) {
        return cand
      }
    }
  }
  return null
}

export function buildBridgeFilesForDriver(driverId: string): Record<string, string> | undefined {
  if (driverId !== 'cc') return undefined
  const mod = loadBoxBridgeMod()
  const bridgeFiles: Record<string, string> = {
    'host.py': Buffer.from(mod.hostPy, 'utf8').toString('base64'),
  }
  for (const [rel, b64] of Object.entries(mod.files)) {
    bridgeFiles[`mod/oc-bridge/${rel}`] = b64
  }
  return bridgeFiles
}

export function buildDefaultDriverContextForNode(
  input: DefaultDriverContextForNodeInput,
): Record<string, unknown> {
  const home = input.sshUser === 'root' ? '/root' : `/home/${input.sshUser}`
  const mcpClientPath = `/opt/openclaude/remote-driver/${input.controllerSha256}/core/mcp_client.py`
  if (input.driverId === 'cc') {
    const cliVer =
      typeof input.cliVersion === 'string' && input.cliVersion.trim().length > 0
        ? input.cliVersion.trim()
        : '2.1.316'
    const bridgeFiles = input.includeBridgeFiles ? buildBridgeFilesForDriver('cc') : undefined
    return {
      mcpClientPath,
      cliPath: `${home}/.oc-remote-cc/claude-${cliVer}`,
      accountHome: home,
      profileName: input.profileName,
      bridgeSha256: loadBoxBridgeMod().sha256,
      ...(bridgeFiles ? { bridgeFiles } : {}),
    }
  }
  if (input.driverId === 'codex') {
    return {
      mcpClientPath,
      cliPath: '/usr/bin/codex',
      nativePath:
        '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
      codexHome: `${home}/.oc-remote-codex/profiles/${input.profileName}/codex-home`,
    }
  }
  if (input.driverId === 'antigravity') {
    return {
      mcpClientPath,
      cliPath: `${home}/.local/bin/agy`,
      qemuPath: `${home}/.local/lib/antigravity-compat/usr/bin/qemu-x86_64-static`,
      accountHome: home,
      profileName: input.profileName,
    }
  }
  return { mcpClientPath }
}
