/** Inspect-only compatibility view. Never creates, recycles or upgrades a container. */
import { lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_PROMPT_PRIVACY_SUPPORT, type PromptPrivacySupport } from '@openclaude/protocol'
export const PROMPT_PRIVACY_CAPABILITY = 'prompt-privacy-v1'
const RELEASE_LABEL = 'com.openclaude.runtime.release'
export interface PrivacyRuntimeStatus { state: string; imageId?: string; labels?: Record<string, string> }
export function readRuntimeReleaseCapabilities(validatedResolvedPath: string): ReadonlySet<string> | null {
  try {
    const path = join(validatedResolvedPath, 'MANIFEST.json')
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) return null
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; capabilities?: unknown }
    if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion < 1 || !Number.isSafeInteger(manifest.schemaVersion) || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 64 ||
      manifest.capabilities.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(v))) return null
    return new Set(manifest.capabilities)
  } catch { return null }
}
export function makePromptPrivacySupportResolver(deps: {
  inspect(userId: number): Promise<PrivacyRuntimeStatus | null>
  /** Already validated at master startup by resolveRuntimeReleaseMount. */
  validatedReleasePath?: string
  readCapabilities?: (path: string) => ReadonlySet<string> | null
}): (userId: string) => Promise<PromptPrivacySupport> {
  const expected = deps.validatedReleasePath ? basename(deps.validatedReleasePath) : null
  const capabilities = deps.validatedReleasePath && expected && /^rel-[a-f0-9]{12}$/.test(expected)
    ? (deps.readCapabilities ?? readRuntimeReleaseCapabilities)(deps.validatedReleasePath) : null
  const view = (state: PromptPrivacySupport['state']): PromptPrivacySupport => ({ version: 1, state })
  return async userId => {
    const id = Number(userId)
    if (!/^[1-9][0-9]*$/.test(userId) || !Number.isSafeInteger(id) || id < 1) return { ...DEFAULT_PROMPT_PRIVACY_SUPPORT }
    try {
      const actual = await deps.inspect(id)
      if (!actual || actual.state !== 'running' || !actual.labels) return view('unknown')
      const release = actual.labels[RELEASE_LABEL]
      if (release) {
        if (!/^rel-[a-f0-9]{12}$/.test(release)) return view('unknown')
        if (!expected) return view('unknown')
        if (release !== expected) return view('upgrade_required')
        return !capabilities ? view('unknown') : view(capabilities.has(PROMPT_PRIVACY_CAPABILITY) ? 'ready' : 'upgrade_required')
      }
      // Embedded mode can assert its own source capability; a slim image cannot.
      if (!/^sha256:[a-f0-9]{64}$/.test(actual.imageId ?? '') || actual.labels['oc.runtime.embed_source'] !== '1') return view('unknown')
      const raw = actual.labels['oc.runtime.features'] ?? ''
      if (raw.length > 8192) return view('unknown')
      return view(raw.trim().split(/\s+/).includes(PROMPT_PRIVACY_CAPABILITY) ? 'ready' : 'upgrade_required')
    } catch { return view('unknown') }
  }
}
