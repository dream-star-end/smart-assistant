import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI_ENTRY = path.join(PKG_ROOT, 'src', 'ocMemoryCli.ts')
const TSX_BIN = path.resolve(PKG_ROOT, '..', '..', 'node_modules', '.bin', 'tsx')

async function runOcMemoryCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const res = await execFileAsync(TSX_BIN, [CLI_ENTRY, ...args], {
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout: res.stdout, stderr: res.stderr, code: 0 }
  } catch (err: any) {
    return {
      stdout: typeof err?.stdout === 'string' ? err.stdout : '',
      stderr: typeof err?.stderr === 'string' ? err.stderr : String(err?.message ?? err),
      code: typeof err?.code === 'number' ? err.code : 1,
    }
  }
}

describe('OCV5-894 oc-memory skill CLI (strictly read-only, full-pipe, tokenless read path)', () => {
  test('reads user + baseline skills with zero DB writes, full >180KB pipe flush, and production SkillDraftStore arm parity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oc-mem-skill-cli-'))
    const prevHome = process.env.OPENCLAUDE_HOME
    const prevBaseline = process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
    try {
      const ocHome = path.join(root, 'oc-home')
      const baselineDir = path.join(root, 'baseline-skills')
      const longSkillDir = path.join(ocHome, 'skills', 'long-body-demo')
      const baseSkillDir = path.join(baselineDir, 'platform-demo-skill')
      const emptyDraftDir = path.join(root, 'empty-draft-skill')
      const outsideSecret = path.join(root, 'outside-secret.txt')
      await mkdir(ocHome, { recursive: true })
      await mkdir(longSkillDir, { recursive: true })
      await mkdir(baseSkillDir, { recursive: true })
      await mkdir(emptyDraftDir, { recursive: true })
      await writeFile(outsideSecret, 'TOP_SECRET_OUTSIDE_DRAFT\n', 'utf8')

      // Set OPENCLAUDE_HOME BEFORE importing @openclaude/storage so paths.home binds to isolated ocHome
      process.env.OPENCLAUDE_HOME = ocHome
      process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = baselineDir
      const { buildAgentSkillStore, paths, SkillDraftStore } = await import('@openclaude/storage')
      const { handleSkillListRead, handleSkillSearchRead, handleSkillViewRead } = await import(
        '../skillReadTools.js'
      )
      assert.equal(paths.home, ocHome, 'storage paths.home must bind to isolated test ocHome')

      const store = buildAgentSkillStore('main')
      const publishedChecklist = 'Published checklist v1.0.0 unchanged attachment\n'
      const savedV1 = await store.save(
        {
          name: 'swarm-decentralize-demo',
          description: 'Decentralized peer-to-peer swarm playbook demo',
          tags: ['swarm', 'p2p'],
        },
        '# Published Swarm Body\nFollow P2P handoff.\n',
      )
      assert.equal(savedV1.ok, true)
      const userSkillDir = path.join(paths.sharedSkillsDir, 'swarm-decentralize-demo')
      await mkdir(path.join(userSkillDir, 'references'), { recursive: true })
      await writeFile(path.join(userSkillDir, 'references', 'checklist.md'), publishedChecklist, 'utf8')

      // 200 KB skill body to prove stdout flushes completely past OS 64 KiB pipe buffer
      const sentinel = 'END_SENTINEL_OCV5_894_COMPLETE_TAIL'
      const longBody = [
        '---',
        'name: long-body-demo',
        'description: Oversized skill payload flush regression test',
        '---',
        '',
        'A'.repeat(200_000),
        sentinel,
        '',
      ].join('\n')
      await writeFile(path.join(longSkillDir, 'SKILL.md'), longBody, 'utf8')

      await writeFile(
        path.join(baseSkillDir, 'SKILL.md'),
        [
          '---',
          'name: platform-demo-skill',
          'description: Platform baseline demo instructions',
          'tags: [baseline]',
          '---',
          '',
          '# Baseline Body',
          '',
        ].join('\n'),
        'utf8',
      )

      // Real SkillDraftStore.writeDraft stages ONLY SKILL.md + draft.json (never copies references/)
      const drafts = new SkillDraftStore()
      const draftRunId = 'run-r2-b4-parity'
      const wroteDraft = await drafts.writeDraft({
        runId: draftRunId,
        meta: {
          name: 'swarm-decentralize-demo',
          description: 'Candidate draft description only',
          tags: ['swarm', 'draft-candidate'],
        },
        body: '# Draft Body Only\nUse references/checklist.md.\n',
        baseVersion: '1.0.0',
        rationale: 'Update body only while preserving existing attachments',
      })
      assert.equal(wroteDraft.ok, true)
      const draftDir = path.join(paths.skillDraftRunDir(draftRunId), 'swarm-decentralize-demo')
      assert.equal(
        existsSync(path.join(draftDir, 'references', 'checklist.md')),
        false,
        'precondition: real SkillDraftStore.writeDraft must not copy existing attachments into draftDir',
      )

      // Also stage a real delete-op draft to verify unavailable draft fails closed on list/search/view
      const deleteRunId = 'run-r2-b4-delete'
      const wroteDelete = await drafts.writeDraft({
        runId: deleteRunId,
        op: 'delete',
        meta: { name: 'swarm-decentralize-demo', description: '' },
        body: '',
      })
      assert.equal(wroteDelete.ok, true)
      const deleteDraftDir = path.join(paths.skillDraftRunDir(deleteRunId), 'swarm-decentralize-demo')

      const baseEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        OPENCLAUDE_HOME: ocHome,
        OPENCLAUDE_AGENT_ID: 'main',
        OPENCLAUDE_BASELINE_SKILLS_DIR: baselineDir,
        // Even if master relay env exists, read-only CLI MUST NOT perform remote HTTP calls
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'unused-token',
      }
      const excludedEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        OPENCLAUDE_SKILL_EVAL_EXCLUDE: 'swarm-decentralize-demo',
      }
      const draftEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: 'swarm-decentralize-demo',
        OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: draftDir,
      }
      const missingDraftEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: 'swarm-decentralize-demo',
        OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: emptyDraftDir,
      }
      const deleteDraftEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: 'swarm-decentralize-demo',
        OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: deleteDraftDir,
      }

      // --- Part A: Fast shared-handler matrix (covers both MCP & CLI read paths) ---
      const ctx = (env: NodeJS.ProcessEnv) => ({ agentId: 'main', env, allowSideEffects: false })

      const listed = await handleSkillListRead(store, ctx(baseEnv))
      assert.equal(listed.isError, undefined)
      assert.ok(listed.content[0].text.includes('platform-demo-skill'))
      assert.ok(listed.content[0].text.includes('swarm-decentralize-demo'))

      const listedPlatform = await handleSkillListRead(store, ctx(baseEnv), { source: 'platform' })
      assert.equal(listedPlatform.isError, undefined)
      assert.ok(listedPlatform.content[0].text.includes('platform-demo-skill'))
      assert.ok(!listedPlatform.content[0].text.includes('swarm-decentralize-demo'))

      const searched = await handleSkillSearchRead(store, { query: 'peer-to-peer', limit: 5 }, ctx(baseEnv))
      assert.equal(searched.isError, undefined)
      assert.ok(searched.content[0].text.includes('swarm-decentralize-demo'))

      const excludedView = await handleSkillViewRead(store, { name: 'swarm-decentralize-demo' }, ctx(excludedEnv))
      assert.equal(excludedView.isError, true)
      assert.match(excludedView.content[0].text, /skill not found/)

      const draftList = await handleSkillListRead(store, ctx(draftEnv))
      assert.ok(draftList.content[0].text.includes('Candidate draft description only'))
      assert.ok(!draftList.content[0].text.includes('Decentralized peer-to-peer swarm playbook demo'))

      const draftSearch = await handleSkillSearchRead(store, { query: 'Candidate draft', limit: 5 }, ctx(draftEnv))
      assert.ok(draftSearch.content[0].text.includes('swarm-decentralize-demo'))
      assert.ok(draftSearch.content[0].text.includes('Candidate draft description only'))

      const traversalSub = await handleSkillViewRead(
        store,
        { name: 'swarm-decentralize-demo', subfile: 'references/../SKILL.md' },
        ctx(draftEnv),
      )
      assert.equal(traversalSub.isError, true)
      assert.ok(!traversalSub.content[0].text.includes('# Published Swarm Body'))

      const stagingSub = await handleSkillViewRead(
        store,
        { name: 'swarm-decentralize-demo', subfile: 'draft.json' },
        ctx(draftEnv),
      )
      assert.equal(stagingSub.isError, true)

      await symlink(outsideSecret, path.join(draftDir, 'evil-link.md'))
      const symlinkSub = await handleSkillViewRead(
        store,
        { name: 'swarm-decentralize-demo', subfile: 'evil-link.md' },
        ctx(draftEnv),
      )
      assert.equal(symlinkSub.isError, true)
      assert.ok(!symlinkSub.content[0].text.includes('TOP_SECRET_OUTSIDE_DRAFT'))

      // Both emptyDraftDir and real op='delete' draft fail closed across list, search, view, and subfile
      for (const unavailEnv of [missingDraftEnv, deleteDraftEnv]) {
        const uView = await handleSkillViewRead(store, { name: 'swarm-decentralize-demo' }, ctx(unavailEnv))
        assert.equal(uView.isError, true)
        assert.ok(!uView.content[0].text.includes('# Published Swarm Body'))

        const uSub = await handleSkillViewRead(
          store,
          { name: 'swarm-decentralize-demo', subfile: 'references/checklist.md' },
          ctx(unavailEnv),
        )
        assert.equal(uSub.isError, true)
        assert.ok(!uSub.content[0].text.includes('Published checklist'))

        const uList = await handleSkillListRead(store, ctx(unavailEnv))
        assert.equal(uList.isError, undefined)
        assert.ok(!uList.content[0].text.includes('swarm-decentralize-demo'))
        assert.ok(!uList.content[0].text.includes('Decentralized peer-to-peer swarm playbook demo'))

        const uSearch = await handleSkillSearchRead(store, { query: 'peer-to-peer', limit: 5 }, ctx(unavailEnv))
        assert.equal(uSearch.isError, undefined)
        assert.ok(!uSearch.content[0].text.includes('swarm-decentralize-demo'))
        assert.ok(!uSearch.content[0].text.includes('Decentralized peer-to-peer swarm playbook demo'))
      }

      // Invalid args fail closed
      assert.equal((await handleSkillSearchRead(store, { query: '' }, ctx(baseEnv))).isError, true)
      assert.equal((await handleSkillViewRead(store, { name: '' }, ctx(baseEnv))).isError, true)
      assert.equal((await handleSkillListRead(store, ctx(baseEnv), { source: 'invalid' })).isError, true)

      // --- Part B: Real spawned oc-memory CLI E2E (Stage 1 current + Stage 2 draft + 200KB pipe + missing draft) ---
      const [
        cliV1Sub,
        cliLongView,
        cliDraftMain,
        cliDraftAlias,
        cliDraftSub,
        cliMissingList,
        cliMissingSearch,
        cliMissingView,
      ] = await Promise.all([
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo', '--subfile', 'references/checklist.md'], baseEnv),
        runOcMemoryCli(['skill-view', 'long-body-demo'], baseEnv),
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo'], draftEnv),
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo', '--subfile', './SKILL.md'], draftEnv),
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo', '--subfile', 'references/checklist.md'], draftEnv),
        runOcMemoryCli(['skill-list'], missingDraftEnv),
        runOcMemoryCli(['skill-search', 'peer-to-peer', '--limit', '5'], missingDraftEnv),
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo'], missingDraftEnv),
      ])

      // Stage 1 (v1.0.0) attachment
      assert.equal(cliV1Sub.code, 0, cliV1Sub.stderr)
      assert.equal(cliV1Sub.stdout, publishedChecklist)

      // Blocker 3: >200KB OS pipe flush completes through trailing sentinel
      assert.equal(cliLongView.code, 0, cliLongView.stderr)
      assert.ok(
        Buffer.byteLength(cliLongView.stdout, 'utf8') > 200_000,
        `expected >200KB stdout, got ${Buffer.byteLength(cliLongView.stdout, 'utf8')}`,
      )
      assert.ok(cliLongView.stdout.trimEnd().endsWith(sentinel), 'trailing sentinel must survive OS pipe flush')

      // Stage 2 (real SkillDraftStore draft arm): candidate body for main & ./SKILL.md, unchanged attachment readable
      assert.equal(cliDraftMain.code, 0, cliDraftMain.stderr)
      assert.ok(cliDraftMain.stdout.includes('# Draft Body Only'))
      assert.ok(!cliDraftMain.stdout.includes('# Published Swarm Body'))

      assert.equal(cliDraftAlias.code, 0, cliDraftAlias.stderr)
      assert.ok(cliDraftAlias.stdout.includes('# Draft Body Only'))
      assert.ok(!cliDraftAlias.stdout.includes('# Published Swarm Body'))

      assert.equal(cliDraftSub.code, 0, cliDraftSub.stderr)
      assert.equal(cliDraftSub.stdout, cliV1Sub.stdout, 'draft arm must read exact unchanged attachment from v1.0.0')

      // Missing draft fails closed in real CLI list/search/view too
      assert.equal(cliMissingList.code, 0, cliMissingList.stderr)
      assert.ok(!cliMissingList.stdout.includes('swarm-decentralize-demo'))
      assert.ok(!cliMissingList.stdout.includes('Decentralized peer-to-peer swarm playbook demo'))
      assert.equal(cliMissingSearch.code, 0, cliMissingSearch.stderr)
      assert.ok(!cliMissingSearch.stdout.includes('swarm-decentralize-demo'))
      assert.notEqual(cliMissingView.code, 0)
      assert.ok(!cliMissingView.stdout.includes('# Published Swarm Body'))

      // Blocker 5: strictly read-only — ZERO sessions.db created or written!
      assert.equal(
        existsSync(path.join(ocHome, 'sessions.db')),
        false,
        'read-only oc-memory skill CLI must NOT create or write sessions.db',
      )

      // --- Part C: Stage 3 (real SkillStore.save merge to v1.0.1) ---
      const draftContent = await drafts.readDraft(draftRunId, 'swarm-decentralize-demo')
      assert.ok(draftContent)
      const mergedV2 = await store.save(draftContent.meta, draftContent.body)
      assert.equal(mergedV2.ok, true)
      const [cliV2Main, cliV2Sub] = await Promise.all([
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo'], baseEnv),
        runOcMemoryCli(['skill-view', 'swarm-decentralize-demo', '--subfile', 'references/checklist.md'], baseEnv),
      ])
      assert.equal(cliV2Main.code, 0, cliV2Main.stderr)
      assert.ok(cliV2Main.stdout.includes('# Draft Body Only'))
      assert.equal(cliV2Sub.code, 0, cliV2Sub.stderr)
      assert.equal(cliV2Sub.stdout, cliV1Sub.stdout, 'v1.0.1 merged attachment must equal v1.0.0')
      assert.equal(cliV2Sub.stdout, cliDraftSub.stdout, 'v1.0.1 merged attachment must equal draft arm')
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
      else process.env.OPENCLAUDE_HOME = prevHome
      if (prevBaseline === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_BASELINE_SKILLS_DIR')
      else process.env.OPENCLAUDE_BASELINE_SKILLS_DIR = prevBaseline
      await rm(root, { recursive: true, force: true })
    }
  })
})
