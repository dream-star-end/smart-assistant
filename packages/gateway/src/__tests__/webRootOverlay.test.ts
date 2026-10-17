/**
 * P0-Web webRoot 决策(OCV5-489)。
 * Run: npx tsx --test packages/gateway/src/__tests__/webRootOverlay.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveV5WebRoot } from '../webRootOverlay.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function layout(relName = 'rel-abc123-20261017-000000') {
  const root = mkdtempSync(join(tmpdir(), 'oc-webroot-'))
  tmpDirs.push(root)
  const rel = join(root, 'releases', relName)
  const dist = join(rel, 'packages', 'web-react', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), 'release')
  const live = join(root, 'live')
  symlinkSync(rel, live)
  const overlayRoot = join(root, 'overlay')
  const webroot = join(overlayRoot, relName, 'webroots', 'b1')
  mkdirSync(webroot, { recursive: true })
  writeFileSync(join(webroot, 'index.html'), 'overlay')
  return { root, rel, dist, live, overlayRoot, webroot, relName }
}

describe('resolveV5WebRoot', () => {
  it('uses the release dist when no overlay root is configured', () => {
    const l = layout()
    const d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: undefined })
    assert.equal(d.webRoot, l.dist)
    assert.equal(d.overlay, false)
  })

  it('uses the release dist when this release has no pointer yet', () => {
    const l = layout()
    const d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: l.overlayRoot })
    assert.equal(d.webRoot, l.dist)
    assert.equal(d.overlay, false)
  })

  it('serves the unresolved pointer path keyed by the live release directory name', () => {
    const l = layout()
    const pointer = join(l.overlayRoot, l.relName, 'current')
    symlinkSync(l.webroot, pointer)
    const d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: l.overlayRoot })
    assert.equal(d.overlay, true)
    assert.equal(d.webRoot, pointer, 'must keep the symlink path so later flips are followed')
  })

  it('never applies another release bucket', () => {
    const l = layout()
    const other = join(l.overlayRoot, 'rel-other-20261016-000000')
    mkdirSync(other, { recursive: true })
    symlinkSync(l.webroot, join(other, 'current'))
    const d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: l.overlayRoot })
    assert.equal(d.overlay, false)
  })

  it('falls back when the pointer is a plain directory or its webroot lacks index.html', () => {
    const l = layout()
    mkdirSync(join(l.overlayRoot, l.relName, 'current'))
    let d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: l.overlayRoot })
    assert.equal(d.overlay, false)

    const l2 = layout()
    const empty = join(l2.overlayRoot, l2.relName, 'webroots', 'empty')
    mkdirSync(empty, { recursive: true })
    symlinkSync(empty, join(l2.overlayRoot, l2.relName, 'current'))
    d = resolveV5WebRoot({ releaseDist: l2.dist, releaseRoot: l2.live, overlayRoot: l2.overlayRoot })
    assert.equal(d.overlay, false)
  })

  it('does not apply to a dev worktree (not a rel-* directory)', () => {
    const l = layout('ocv5-489-p0web')
    symlinkSync(l.webroot, join(l.overlayRoot, 'ocv5-489-p0web', 'current'))
    const d = resolveV5WebRoot({ releaseDist: l.dist, releaseRoot: l.live, overlayRoot: l.overlayRoot })
    assert.equal(d.overlay, false)
  })
})
