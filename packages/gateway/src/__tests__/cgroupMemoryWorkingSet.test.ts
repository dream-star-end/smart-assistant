import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DEFAULT_CGROUP_V1_STAT_PATH,
  DEFAULT_CGROUP_V2_STAT_PATH,
  parseReclaimableFileCacheBytes,
  readCgroupMemoryUsage,
  readCgroupMemoryUsageSync as readCgroupMemoryUsageSyncWithReader,
  type CgroupMemoryPaths,
} from '../cgroupMemoryGuard.js'
import { readDelegateMemoryPressure } from '../delegateRuntime.js'
import { Gateway } from '../server.js'

function readCgroupMemoryUsageSync(paths?: CgroupMemoryPaths) {
  return readCgroupMemoryUsageSyncWithReader(paths, (p) => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  })
}

describe('cgroupMemoryWorkingSet (OCV5-923)', () => {
  it('exports default cgroup v2 and v1 memory.stat paths', () => {
    assert.equal(DEFAULT_CGROUP_V2_STAT_PATH, '/sys/fs/cgroup/memory.stat')
    assert.equal(DEFAULT_CGROUP_V1_STAT_PATH, '/sys/fs/cgroup/memory/memory.stat')
  })

  it('parses reclaimable page cache bytes cleanly for v2 and v1 with BigInt precision', () => {
    const v2Stat = [
      'anon 1073741824',
      'file 536870912',
      'active_file 100000000',
      'total_inactive_file 999999999',
      'inactive_file 436870912',
      'slab 123456',
    ].join('\n')
    assert.equal(parseReclaimableFileCacheBytes(v2Stat, 'v2'), 436870912n)

    // v1 prefers total_inactive_file over inactive_file
    const v1Both = [
      'cache 600000000',
      'inactive_file 200000000',
      'total_inactive_file 450000000',
    ].join('\n')
    assert.equal(parseReclaimableFileCacheBytes(v1Both, 'v1'), 450000000n)

    // v1 falls back to inactive_file when total_inactive_file is absent
    const v1Fallback = ['cache 600000000', 'inactive_file\t200000000\r'].join('\n')
    assert.equal(parseReclaimableFileCacheBytes(v1Fallback, 'v1'), 200000000n)

    // BigInt precision beyond Number.MAX_SAFE_INTEGER
    const bigVal = '9007199254740993'
    assert.equal(parseReclaimableFileCacheBytes(`inactive_file ${bigVal}\n`, 'v2'), 9007199254740993n)

    // Missing / malformed / negative / multiline values fall back safely to 0n
    assert.equal(parseReclaimableFileCacheBytes('', 'v2'), 0n)
    assert.equal(parseReclaimableFileCacheBytes('anon 1234\nactive_file 5678\n', 'v2'), 0n)
    assert.equal(parseReclaimableFileCacheBytes('inactive_file notanumber\n', 'v2'), 0n)
    assert.equal(parseReclaimableFileCacheBytes('inactive_file -123\n', 'v2'), 0n)
    assert.equal(parseReclaimableFileCacheBytes('inactive_file \n12345\n', 'v2'), 0n)
    assert.equal(parseReclaimableFileCacheBytes('inactive_file 123 extra\n', 'v2'), 0n)
  })

  it('computes cgroup v2 working set (memory.current - inactive_file) in both async and sync readers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-v2-'))
    try {
      const v2CurrentPath = join(dir, 'memory.current')
      const v2MaxPath = join(dir, 'memory.max')
      const v2StatPath = join(dir, 'memory.stat')
      const v1CurrentPath = join(dir, 'missing-v1-cur')
      const v1MaxPath = join(dir, 'missing-v1-max')

      await writeFile(v2CurrentPath, '950000000\n')
      await writeFile(v2MaxPath, '1000000000\n')
      await writeFile(v2StatPath, 'anon 650000000\nactive_file 50000000\ninactive_file 300000000\n')

      const paths = { v2CurrentPath, v2MaxPath, v2StatPath, v1CurrentPath, v1MaxPath }
      const asyncReading = await readCgroupMemoryUsage(paths)
      const syncReading = readCgroupMemoryUsageSync(paths)

      for (const reading of [asyncReading, syncReading]) {
        assert.ok(reading)
        assert.equal(reading.version, 'v2')
        assert.equal(reading.rawCurrentBytes, 950_000_000)
        assert.equal(reading.reclaimableCacheBytes, 300_000_000)
        assert.equal(reading.currentBytes, 650_000_000)
        assert.equal(reading.maxBytes, 1_000_000_000)
        assert.equal(reading.ratio, 0.65)
      }

      // Omitting v2StatPath derives sibling memory.stat from v2CurrentPath
      const siblingReading = readCgroupMemoryUsageSync({
        v2CurrentPath,
        v2MaxPath,
        v1CurrentPath,
        v1MaxPath,
      })
      assert.equal(siblingReading?.currentBytes, 650_000_000)
      assert.equal(siblingReading?.ratio, 0.65)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('computes cgroup v1 working set (total_inactive_file preferred, inactive_file fallback)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-v1-'))
    try {
      const v2CurrentPath = join(dir, 'v2.cur')
      const v2MaxPath = join(dir, 'v2.max')
      const v1CurrentPath = join(dir, 'memory.usage_in_bytes')
      const v1MaxPath = join(dir, 'memory.limit_in_bytes')
      const v1StatPath = join(dir, 'memory.stat')

      // v2 unlimited ("max") -> must fall back cleanly to v1
      await writeFile(v2CurrentPath, '999999999\n')
      await writeFile(v2MaxPath, 'max\n')
      await writeFile(v1CurrentPath, '900000000\n')
      await writeFile(v1MaxPath, '1000000000\n')
      await writeFile(v1StatPath, 'inactive_file 100000000\ntotal_inactive_file 400000000\n')

      const paths = { v2CurrentPath, v2MaxPath, v1CurrentPath, v1MaxPath, v1StatPath }
      const rPreferredAsync = await readCgroupMemoryUsage(paths)
      const rPreferredSync = readCgroupMemoryUsageSync(paths)
      for (const r of [rPreferredAsync, rPreferredSync]) {
        assert.ok(r)
        assert.equal(r.version, 'v1')
        assert.equal(r.rawCurrentBytes, 900_000_000)
        assert.equal(r.reclaimableCacheBytes, 400_000_000)
        assert.equal(r.currentBytes, 500_000_000)
        assert.equal(r.ratio, 0.5)
      }

      // Without total_inactive_file -> fall back to inactive_file
      await writeFile(v1StatPath, 'cache 500000000\ninactive_file 250000000\n')
      const rFallbackAsync = await readCgroupMemoryUsage(paths)
      const rFallbackSync = readCgroupMemoryUsageSync(paths)
      for (const r of [rFallbackAsync, rFallbackSync]) {
        assert.ok(r)
        assert.equal(r.version, 'v1')
        assert.equal(r.reclaimableCacheBytes, 250_000_000)
        assert.equal(r.currentBytes, 650_000_000)
        assert.equal(r.ratio, 0.65)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enforces same-version pairing (never mixes v2 current with v1 max)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-pair-'))
    try {
      const v2CurrentPath = join(dir, 'v2.current')
      const v2MaxPath = join(dir, 'v2.missing.max')
      const v1CurrentPath = join(dir, 'v1.usage')
      const v1MaxPath = join(dir, 'v1.limit')
      const v1StatPath = join(dir, 'v1.stat')

      // v2 has current=950M (but missing max); v1 has usage=400M, limit=1000M, total_inactive_file=100M
      await writeFile(v2CurrentPath, '950000000\n')
      await writeFile(v1CurrentPath, '400000000\n')
      await writeFile(v1MaxPath, '1000000000\n')
      await writeFile(v1StatPath, 'total_inactive_file 100000000\n')

      const paths = { v2CurrentPath, v2MaxPath, v1CurrentPath, v1MaxPath, v1StatPath }
      const asyncReading = await readCgroupMemoryUsage(paths)
      const syncReading = readCgroupMemoryUsageSync(paths)

      for (const r of [asyncReading, syncReading]) {
        assert.ok(r)
        assert.equal(r.version, 'v1')
        assert.equal(r.rawCurrentBytes, 400_000_000)
        assert.equal(r.currentBytes, 300_000_000)
        assert.equal(r.ratio, 0.3)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back cleanly to raw memory.current when memory.stat is missing or malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-fallback-'))
    try {
      const v2CurrentPath = join(dir, 'memory.current')
      const v2MaxPath = join(dir, 'memory.max')
      const v2StatPath = join(dir, 'memory.stat')
      const v1CurrentPath = join(dir, 'missing-v1-cur')
      const v1MaxPath = join(dir, 'missing-v1-max')

      await writeFile(v2CurrentPath, '800000000\n')
      await writeFile(v2MaxPath, '1000000000\n')

      // Missing memory.stat (must NOT read host /sys/fs/cgroup/memory.stat)
      const pathsMissing = { v2CurrentPath, v2MaxPath, v1CurrentPath, v1MaxPath }
      for (const r of [await readCgroupMemoryUsage(pathsMissing), readCgroupMemoryUsageSync(pathsMissing)]) {
        assert.ok(r)
        assert.equal(r.currentBytes, 800_000_000)
        assert.equal(r.rawCurrentBytes, 800_000_000)
        assert.equal(r.reclaimableCacheBytes, 0)
        assert.equal(r.ratio, 0.8)
      }

      // Malformed memory.stat
      await writeFile(v2StatPath, 'corrupt garbage\ninactive_file NaN\n')
      const pathsMalformed = { v2CurrentPath, v2MaxPath, v2StatPath, v1CurrentPath, v1MaxPath }
      for (const r of [await readCgroupMemoryUsage(pathsMalformed), readCgroupMemoryUsageSync(pathsMalformed)]) {
        assert.ok(r)
        assert.equal(r.currentBytes, 800_000_000)
        assert.equal(r.rawCurrentBytes, 800_000_000)
        assert.equal(r.reclaimableCacheBytes, 0)
        assert.equal(r.ratio, 0.8)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clamps non-atomic skew (inactive_file > memory.current) safely to 0 without rejecting zero working set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-skew-'))
    try {
      const v2CurrentPath = join(dir, 'memory.current')
      const v2MaxPath = join(dir, 'memory.max')
      const v2StatPath = join(dir, 'memory.stat')
      const v1CurrentPath = join(dir, 'missing-v1-cur')
      const v1MaxPath = join(dir, 'missing-v1-max')

      await writeFile(v2CurrentPath, '100000000\n')
      await writeFile(v2MaxPath, '1000000000\n')
      await writeFile(v2StatPath, 'inactive_file 250000000\n')

      const paths = { v2CurrentPath, v2MaxPath, v2StatPath, v1CurrentPath, v1MaxPath }
      for (const r of [await readCgroupMemoryUsage(paths), readCgroupMemoryUsageSync(paths)]) {
        assert.ok(r)
        assert.equal(r.currentBytes, 0)
        assert.equal(r.ratio, 0)
        assert.equal(r.rawCurrentBytes, 100_000_000)
        assert.equal(r.reclaimableCacheBytes, 250_000_000)
      }

      // readDelegateMemoryPressure must NOT reject current === 0 with !current
      const pressure = readDelegateMemoryPressure(paths)
      assert.deepEqual(pressure, { current: 0, max: 1_000_000_000, ratio: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delegate 85% memory gate allows 95% raw with 30% inactive_file (65% working set) and still blocks 95% anon memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-ws-gate-'))
    const origRatioEnv = process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO
    delete process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO
    try {
      const v2CurrentPath = join(dir, 'memory.current')
      const v2MaxPath = join(dir, 'memory.max')
      const v2StatPath = join(dir, 'memory.stat')
      const v1CurrentPath = join(dir, 'missing-v1-cur')
      const v1MaxPath = join(dir, 'missing-v1-max')
      const paths = { v2CurrentPath, v2MaxPath, v2StatPath, v1CurrentPath, v1MaxPath }

      const gw = Object.create(Gateway.prototype) as any
      gw._activeDelegations = 0
      gw._readDelegateMemoryPressure = () => readDelegateMemoryPressure(paths)

      // Scenario A: 95% memory.current, 30% reclaimable inactive_file -> 65% working set (< 85% gate)
      await writeFile(v2CurrentPath, '950000000\n')
      await writeFile(v2MaxPath, '1000000000\n')
      await writeFile(v2StatPath, 'anon 650000000\ninactive_file 300000000\n')

      const cachedPressure = readDelegateMemoryPressure(paths)
      assert.deepEqual(cachedPressure, {
        current: 650_000_000,
        max: 1_000_000_000,
        ratio: 0.65,
      })
      const cachedGate = gw._checkDelegateResourceGate()
      assert.equal(cachedGate, null, '65% working set must NOT trigger 85% delegate gate')

      // Scenario B: 95% memory.current, 0% inactive_file (95% anon) -> 95% working set (>= 85% gate)
      await writeFile(v2StatPath, 'anon 950000000\ninactive_file 0\n')

      const anonPressure = readDelegateMemoryPressure(paths)
      assert.deepEqual(anonPressure, {
        current: 950_000_000,
        max: 1_000_000_000,
        ratio: 0.95,
      })
      const anonGate = gw._checkDelegateResourceGate()
      assert.deepEqual(
        anonGate,
        { kind: 'memory', pct: 95, limitPct: 85 },
        '95% anon working set MUST still trigger 85% delegate gate',
      )
    } finally {
      if (origRatioEnv === undefined) delete process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO
      else process.env.OPENCLAUDE_DELEGATE_MEMORY_PRESSURE_RATIO = origRatioEnv
      await rm(dir, { recursive: true, force: true })
    }
  })
})
