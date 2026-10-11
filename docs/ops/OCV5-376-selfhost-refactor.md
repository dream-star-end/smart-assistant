# OCV5-376 — V5 selfhost: refactor and cleanup after the 2026-10-11 assessment

Scope: V5 selfhost (feat/v5-selfhost) only. Each item below says what was measured, what changed,
and what was deliberately left alone. Evidence logs are on v5-dev under
`workspace/ocv5-308/g376-*`.

## P1 — local web-react gate: ~60 min → ~10 min

- Cause: `vitest run --maxWorkers=1` (since 2026-08-21). Every test file pays a cold jsdom load
  (`require('jsdom')` alone is 3.3 s CPU on v5-dev) and `setup.ts` preloaded the tool-card bodies
  for all 346 files. Serial runs stack those costs; hosted CI ran the same command in ~9 min.
- Change: files run in parallel (`maxWorkers: "50%"`). The global preload is gone; files that need
  a lazy chunk load it in `beforeAll` through `src/test/moduleLoad.ts` (60 s module-load budget
  only; test timeouts are unchanged). App.test loads the 9 lazy centers App itself prefetches.
- Measured on v5-dev: 621–650 s for 346 files / 4969 tests (load average 10–25 from other sessions).
- Found on the way: `lazyToolBody` cached a failed import forever (fixed, with tests).

## P2 — Gateway class, first batch

- `/api/chat-projects*` and `/api/project-assets*` moved to `packages/gateway/src/routes/` as
  `handle…Http(io, req, res, url): boolean`. Mechanical (TypeScript-AST move; only
  sendJson/readBody/getUserId were used). server.ts −455 lines; dispatch order unchanged.
- The container route inventory (commercial test helper behind the bridge-allowlist closure
  checks) now scans `routes/*.ts` too. Without that, moving a route would have silently removed it
  from those checks.
- Next candidates with the same shape: `/api/cron*`, `/api/usage*`, `/api/sessions/*` sidebar
  routes. The delegate and permission blocks share `this` state and need a design first.

## P3 — App(), first steps

- `hooks/useResponseRatings.ts` (ratings, implicit report, completion nudge) and
  `hooks/useSessionEngineOptions.ts` (per-session effort and context tier) moved out verbatim and
  are called where their effects used to be. App.tsx 4976 → 4749 lines. Each hook has its own test.
- Not done: the 17 `useExhaustiveDependencies` reports in App (send, tutorial actions, scroll
  effects). Each needs a decision on stale closures, not a mechanical fix.

## P4 — first-screen budget: margin 1.2 KB → 9.7 KB (budget unchanged)

- The 82 KB "styles" chunk is JS: api.ts + @openclaude/protocol + TypeBox + tailwind-merge.
  "ProcessDisclosure", "lineDiff", "agentNames" are borrowed chunk names for chat cards, tool
  summaries and chat/model+render; the first chat paint needs them, so they stay.
- Change: `packages/protocol` declares `"sideEffects": false`; vite marks TypeBox `Type.*` pure.
  469888 → 461384 bytes gzip. The build prints size and margin every time.
- Left: TypeBox is still ~40 KB minified in the first screen because some frames/goal schemas are
  built with `Type.Union(list.map(...))`, which a bundler cannot drop. Splitting the web-facing
  protocol constants into a TypeBox-free module would free roughly 12 KB gzip more.

## P5 — two trees

- `.github/two-tree/selfhost-only.txt` lists what selfhost may keep different (selfhost deploy,
  selfhost scripts and tests, selfhost CI). `scripts/check-v5-two-tree-divergence.ts` reports the
  rest: 686 paths differ today, 8 allowed, 678 shared (web-react 292, commercial 188, gateway 79).
- CI (v5-selfhost-gates.yml) runs it as a report. After the unified sync, switch it to
  `--enforce`.

## P6 — cleanup (nothing deleted; waiting for the operator)

Proposal with lists: `workspace/ocv5-308/g376-p6/PROPOSAL.md`. Summary: 95 merged clean idle
worktrees (30.7 GB), 429 merged remote branches, 57 stray node_modules directories (7.2 GB),
selfhost release retention 6 → 3 (4.5 GB at the next deploy). Root fs was 97% full.

## P7 — gates that were always red

- `npm run lint` was `biome check packages` (3.4k lint + 4.3k formatting errors; nothing ran it).
  It is now `scripts/check-biome-changed.sh`: changed files only, fails on any added error.
- `check-v5-incident-regressions.ts` stopped at its first entry on selfhost. Now:
  lineage accepts an exact `cherry-pick -x` (same `git patch-id`); `--edition=selfhost` replaces
  the "≤ 11 pending" count with a shrink-only list of 63 incidents whose proof only runs in the
  commercial release; two ledger rows that had rotted were fixed; 42 expired waivers removed;
  trailer closure went from >7 min to seconds (one `rev-list` instead of commit × tip
  `merge-base`). It passes on this tree. Commercial (no `--edition`) behaves as before.
- These now run in `.github/workflows/v5-selfhost-gates.yml`.
- Not covered on selfhost CI: gateway/commercial unit suites (they run only in commercial
  v5-ci.yml, which needs a PG fixture).

## P8 — commercial code in the selfhost master

`node scripts/v5-selfhost-commercial-reach.mjs --root "$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)"`
(esbuild metafile, nothing executed) on rel-36bba5199: 668 of 716 commercial source files
(286k of 298k lines) are statically reachable from `packages/cli/src/index.ts`. The 48 that are
not are mostly the egress entry (a separate process), seed/backfill/backup helpers and a few Box
tool proxy modules. Startup logs show which subsystems start (agent runtime disabled, wechat broker
disabled, external mTLS disabled; leaderBundle members, ChatGPT proxy, container web preview on).

Conclusion: removing code by import graph would gain almost nothing; the cost is in what starts,
which flavor checks already decide. Do not delete or fork commercial modules for selfhost. If
start-up cost matters, measure per-subsystem start time first.

## Also fixed

- `general-assistant` (通用助手) was pinned to GLM-5.3 on selfhost: the approved 1.0.0 manifest
  predates `AGENT_MODEL_AUTO` and the seed refused the changed body on every start. Bumped to 1.0.1;
  a unit test now pins every preset's slug@version → artifact hash.
- Task trees that symlink the whole node_modules to canonical resolve `@openclaude/*` to
  canonical's packages, so their gates test canonical code for cross-package imports. Use
  `scripts/v5-worktree-new.sh` (`--heal` for an existing tree).
