import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('Google replay IDs persist as bounded unique filenames without altering transcript IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemini-result-'))
  try {
    // Bootstrap/logging mocks live in a child, never contaminate the Bun suite.
    const program = `
      import { mock } from 'bun:test';
      import { logMock } from './tests/mocks/log';
      import { debugMock } from './tests/mocks/debug';
      const directory = process.env.GEMINI_STORAGE_TEST_DIR;
      mock.module('src/utils/log.ts', logMock);
      mock.module('src/utils/debug.ts', debugMock);
      mock.module('src/bootstrap/state.ts', () => ({getOriginalCwd: () => directory, getSessionId: () => 'fixture', addSlowOperation: () => {}}));
      mock.module('src/utils/sessionStorage.ts', () => ({getProjectDir: () => directory}));
      mock.module('src/services/analytics/index.ts', () => ({logEvent: () => {}}));
      mock.module('src/services/analytics/growthbook.ts', () => ({getFeatureValue_CACHED_MAY_BE_STALE: (_key, value) => value}));
      mock.module('src/services/analytics/metadata.ts', () => ({sanitizeToolNameForAnalytics: name => name}));
      const {getToolResultPath,persistToolResult} = await import('./src/utils/toolResultStorage.ts');
      const id = 'toolu_g4_' + 'a'.repeat(12000);
      const restored = JSON.parse(JSON.stringify({id})).id;
      const text = await persistToolResult('valuable tool result',id);
      const json = await persistToolResult([{type:'text',text:'json result'}],id);
      if (!('filepath' in text) || !('filepath' in json)) throw Error('persistence failed');
      console.log(JSON.stringify({text:text.filepath,json:json.filepath,replay:getToolResultPath(restored,false),other:getToolResultPath(id+'b',false),ordinary:getToolResultPath('toolu_normal',false)}));
    `
    const result = spawnSync('bun', ['-e', program], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, GEMINI_STORAGE_TEST_DIR: directory },
      encoding: 'utf8', timeout: 30000,
    })
    expect(result.status).toBe(0)
    if (result.status !== 0) throw new Error(result.stderr)
    const paths = JSON.parse(result.stdout)
    expect(basename(paths.text).length).toBeLessThan(100)
    expect(await readFile(paths.text, 'utf8')).toBe('valuable tool result')
    expect(paths.replay).toBe(paths.text)
    expect(paths.other).not.toBe(paths.text)
    expect(JSON.parse(await readFile(paths.json, 'utf8'))).toEqual([{type:'text',text:'json result'}])
    expect(paths.ordinary).toEndWith('toolu_normal.txt')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
