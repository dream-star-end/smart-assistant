import { readdir, readFile, writeFile, cp } from 'fs/promises'
import { join } from 'path'
import { getMacroDefines } from './scripts/defines.ts'

const outdir = 'dist'

// Step 1: Clean output directory
const { rmSync } = await import('fs')
rmSync(outdir, { recursive: true, force: true })

// Collect FEATURE_* env vars → Bun.build features
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))

// [v5 定制 · 关键] **不继承**上游的 DEFAULT_BUILD_FEATURES。
//
// 上游 v2.8.4 新引入了 DEFAULT_BUILD_FEATURES(35 项默认开启);pin a7604f65 时代
// 没有这个概念,features 只来自 FEATURE_* env,而 v5 的 release 构建
// (scripts/v5-runtime-release-lib.sh)不设这些 env —— 即 v5 生产一直是**零 feature**。
// 照搬上游默认会让本次升级同时改变 35 处产品行为,其中对 v5 有实质风险的三类:
//
//   ① 自发 LLM 调用 → 直接影响付费用户账单:EXTRACT_MEMORIES(每 turn 结束 fork 完整
//      消息历史)、VERIFICATION_AGENT(任务完成后 fork 完整消息)、AGENT_TRIGGERS、
//      KAIROS / KAIROS_BRIEF / AWAY_SUMMARY(后台定时摘要)、TRANSCRIPT_CLASSIFIER、
//      EXPERIMENTAL_SKILL_SEARCH(上游注释自承 Haiku-on-first-Chinese-query)。
//   ② 新监听面 / 攻击面:BRIDGE_MODE(远程控制)、DAEMON(长驻 supervisor)、ACP
//      (外部 agent 接入)、DIRECT_CONNECT(claude server/open)、CHICAGO_MCP、
//      COORDINATOR_MODE、AGENT_TRIGGERS_REMOTE。容器有 sudo NOPASSWD,面越小越好。
//   ③ 与 v5 既有机制重叠待评估:ULTRATHINK / ULTRAPLAN(v5 有自己的 effort/thinking
//      权威)、LODESTONE(v5 有自己的 context 定制)、BUDDY(终端宠物,v5 走 web 无意义)。
//
// 因此本批升级保持**行为面零变化**:features 仍只来自 env,让 680 commit 的代码跟进
// 与 feature 开启解耦 —— 出问题才定位得出来。feature 开启走独立批次,逐项评估
// (成本实测 + 安全审 + canary),清单与结论记在 UPSTREAM.md §2.1。
//
// 想临时试某个 feature:`FEATURE_MONITOR_TOOL=1 bun run build`。
const features = envFeatures

// Step 2: Bundle with splitting
//
// target='node' (not 'bun') — produced artifact must run on `node dist/cli.js`,
// since v3 commercial containers launch CCB via Node 22 (claudeCodeRuntime:'node'
// in the container-baked openclaude.json). target='bun' keeps `using` /
// `await using` declarations literal (Stage 3 Explicit Resource Management),
// which Node 22's V8 12.4 parser rejects with SyntaxError, killing the CCB
// subprocess with exit code 1 before it can read its first stdin line.
// target='node' instructs Bun's bundler to lower these to ES2022 try/finally
// (verified: zero `await using` remain in dist/). Bun runtime still accepts
// the lowered output, so dev mode (`bun run dev`) and the 45.32 personal master
// (claudeCodeRuntime:'bun') are unaffected.
//
// Regression: v1.0.173 (built 2026-05-20 on Tokyo master) produced compat
// output; v1.0.194 (built 2026-05-22 on KL master, post primary flip) produced
// `await using` literal in 3 chunks → mass CCB crash-loop reported by users.
// Cause likely a Bun upgrade between the two machines or default-target drift,
// but pinning target='node' eliminates the ambiguity at the source.
const result = await Bun.build({
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  // [v5 定制 · 勿改回上游的 'bun'] 理由见上方注释块:容器用 Node 22 跑
  // `node dist/cli.js`,target='bun' 会保留 `await using` 字面量 → SyntaxError
  // 崩溃循环(2026-05-22 实发事故 d5493c64)。升级时这一行必须守住。
  target: 'node',
  splitting: true,
  // [v5 定制] **不产 sourcemap**。上游 v2.8.4 新增了 sourcemap:'linked'('linked' 会在
  // bundle 末尾写 //# sourceMappingURL= 指针)。不采纳的两条理由:
  //   ① 安全:2026-07-26 平台侧刚做过 sourcemap 封堵批(vite true→'hidden' + Caddy 404 +
  //     直服池 --exclude='*.map' + smoke_sourcemap_sealed 活体门),起因是实测公网 200
  //     泄漏 72 个源文件的完整 sourcesContent。CCB dist 虽不经 Caddy 公网直服,但它以 ro
  //     挂载进容器,而容器内 agent 用户是 NOPASSWD sudo —— .map 会把我们 41 个文件的
  //     定制源码(provider 接入、effort 策略、master /internal/v3/* 路径)完整暴露,
  //     阅读门槛从『读 bundle』降到『读原始 TS』。与平台收紧方向相反,不跟。
  //   ② 本批原则是行为面零变化,pin 时代本就不产 sourcemap;顺带省 ~64MB/release
  //     (实测 .js 33MB / .map 64MB)。
  // 真需要解栈时临时本地构建一份带 map 的即可,不进 release。
  define: {
    ...getMacroDefines(),
    // React production mode — eliminates _debugStack Error objects
    // (6,889 objects × ~1.7KB = 12MB in development builds) and removes
    // prop-type / key warnings not useful in a production CLI tool.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Step 3: Post-process — replace Bun-only `import.meta.require` with Node.js compatible version
const files = await readdir(outdir)
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`

let patched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (content.includes(IMPORT_META_REQUIRE)) {
    await writeFile(
      filePath,
      content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE),
    )
    patched++
  }
}

// Also patch unguarded globalThis.Bun destructuring from third-party deps
// (e.g. @anthropic-ai/sandbox-runtime) so Node.js doesn't crash at import time.
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
BUN_DESTRUCTURE.lastIndex = 0

console.log(
  `Bundled ${result.outputs.length} files to ${outdir}/ (patched ${patched} for import.meta.require, ${bunPatched} for Bun destructure)`,
)

// Step 4: Copy native .node addon files (audio-capture) and vendored binaries (ripgrep)
const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

// [v5 定制] vendored ripgrep 缺失时跳过,不 fail。
// 该目录由 postinstall(scripts/download-ripgrep.ts)联网下载,而 v5 的 release 构建
// 走 `bun install --ignore-scripts`(scripts/v5-runtime-release-lib.sh 硬编码),目录
// 必然不存在 → 上游的无条件 cp 会让 release 构建恒红。
// 不需要它的依据:v5 容器镜像 apt 装了 ripgrep 且 build 期 `rg --version` 验证过
// (Dockerfile.openclaude-runtime),而 CCB 运行时 src/utils/ripgrep.ts 本就优先
// findExecutable('rg') 走系统二进制,vendored 副本只是无系统 rg 时的兜底。
const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
const { existsSync } = await import('fs')
if (existsSync('src/utils/vendor/ripgrep')) {
  await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true })
  console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`)
} else {
  console.log('Skipped vendored ripgrep (absent — v5 containers use the system rg from the image)')
}

// Step 5: Generate cli-bun and cli-node executable entry points
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')

await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n')

// Make both executable
const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)

console.log(`Generated ${cliBun} (shebang: bun) and ${cliNode} (shebang: node)`)
