/**
 * OCV5-748 batch 2: platform system prompt deduplication and engine-scoped injection.
 * Run: npx tsx --test --test-force-exit packages/gateway/src/__tests__/promptSlotsDedupe748.test.ts
 */
import * as assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'oc-dedupe748-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
for (const key of [
  'OPENCLAUDE_PLATFORM_PROMPTS_DIR',
  'OPENCLAUDE_V3_MASTER_BASE_URL',
  'OPENCLAUDE_V3_CONTAINER_TOKEN',
  'OPENCLAUDE_BASELINE_SKILLS_DIR',
  'OC_USER_ROLE',
]) {
  Reflect.deleteProperty(process.env, key)
}

const { buildAgentsSlot, buildPromptContext, buildToolsSlot, PLATFORM_MCP_TOOL_NAMES } =
  await import('../promptSlots.js')

const MEMBERS = [
  { id: 'main', displayName: '全能助手', model: 'deepseek-v4-flash', cap: '默认全能助手' },
  { id: 'auditor', displayName: 'auditor', model: 'gpt-6-astra', cap: '代码和方案审计' },
  { id: 'explorer', displayName: 'explorer', model: 'antigravity-gemini-4-hydrogen', cap: '代码库探索' },
  { id: 'coding-assistant', displayName: '编程助手', model: 'gpt-6-astra', cap: '编程任务交付' },
  { id: 'research-assistant', displayName: '科研助手', model: 'deepseek-v4-flash', cap: '科研文献与精读' },
]

function seedCollaborators(): void {
  for (const m of MEMBERS) {
    const dir = join(TEST_HOME, 'agents', m.id)
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), `# ${m.displayName}\n${m.cap}\n`, 'utf8')
  }
  const yaml = [
    'agents:',
    ...MEMBERS.flatMap((m) => [
      `  - id: ${m.id}`,
      `    displayName: ${m.displayName}`,
      `    model: ${m.model}`,
      '    source: marketplace',
    ]),
    'routes: []',
    'default: main',
    '',
  ].join('\n')
  writeFileSync(join(TEST_HOME, 'agents.yaml'), yaml, 'utf8')
}

seedCollaborators()

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

type BaselineEngine = 'ccb' | 'codex' | 'cursor' | null

function baselineEngineOf(provider: string): BaselineEngine {
  if (provider === 'cursor') return 'cursor'
  if (provider === 'codex' || provider === 'codex-native') return 'codex'
  if (provider === 'ccb' || provider === 'claude-subscription') return 'ccb'
  return null
}

function selectBlocksForSnapshot(text: string, engine: BaselineEngine, channel: 'webchat' | null): string {
  return text
    .replace(
      /<!-- oc-engine:([a-z,]+):start -->\n([\s\S]*?)<!-- oc-engine:\1:end -->\n/g,
      (_all, engines: string, body: string) =>
        engine === null || engines.split(',').includes(engine) ? body : '',
    )
    .replace(
      /<!-- oc-channel:wechat:start -->\n([\s\S]*?)<!-- oc-channel:wechat:end -->\n\n?/g,
      (_all, body: string) => (channel === 'webchat' ? '' : `${body}\n`),
    )
}

function syncDelegateTailBytes(engine: BaselineEngine): number {
  const syncLine =
    engine === 'cursor'
      ? '**同步**: Bash `oc-memory delegate --goal "..."`,返回 `status=running` 时立即用 `oc-memory delegate-wait <jobId>` 续等,不用 Cursor `TaskOutput`。'
      : engine === 'ccb' || engine === 'codex'
        ? '**同步**: MCP `delegate_task`。'
        : '**同步**: CCB/Codex 用 MCP `delegate_task`; Cursor 用 Bash `oc-memory delegate --goal "..."`,返回 `status=running` 时立即用 `oc-memory delegate-wait <jobId>` 续等,不用 Cursor `TaskOutput`。'
  const block = [
    '',
    '**异步**: `send_to_agent(agentId, message)` — 真正后台,立刻返回;完成后系统注入本对话并叫醒你。',
    syncLine,
    '选择 agent 时考虑其模型和能力特长。需要同步拿结果继续处理 → 同步委派;可以先结束本回合、等系统回调 → send_to_agent。',
  ].join('\n')
  return Buffer.byteLength(`\n${block}`, 'utf8')
}

function toolsBytesAtCommit(commit: 'f5a768db6' | '919dd3397'): number {
  if (commit === '919dd3397') {
    const lines = [
      '# 学习系统',
      '',
      '## 记忆工具',
      '',
      '`oc-memory core-search` / `session-search` / `archival-add|search|delete`(Bash)。规则见上方 `# Memory`;详情 `skill_view("memory-management")`。',
      '',
      '## 定时任务',
      '',
      '用户要求定时任务或提醒时,**必须立即创建,不要说做不到**。',
      "计算 cron 前必须立刻在 Bash 运行 `date '+%F %T %z'` 获取带时区的当前时间,不要依赖提示词生成时刻。",
      '快速用法: `create_reminder(schedule="分 时 日 月 周", message="内容", oneshot=true)`;到点执行的任务(非播报提醒)加 `kind="task"`。用户要「这条对话过一会儿再继续」时加 `resume="origin-session"`(不要传 sessionId,网关从当前对话盖章)。',
      '查看/修改/删除: `list_reminders()` / `update_reminder(id, ...)` / `delete_reminder(id)`。这套工具与网页「管理中心 → 定时任务」是同一份数据,用户在页面上建的任务你也能看到。',
      '详细指南见 `skill_view("scheduled-tasks")`。',
      '',
      '## 技能自生成',
      '',
      '不要等用户要求才沉淀经验:完成 3+ 工具调用的复杂任务、修好反复出现的问题或验证出可复用流程后,在最终答复前评估。先 `skill_search(query)` 查重;已有但过时就同名 `skill_save(...)` 更新,没有且可复用才新建。好的 skill = 触发场景 + 前提 + 步骤 + 验证 + 常见坑 + 命令模板;保持泛化,不写一次性隐私、token、短期路径和流水账。',
      '结构与评测规范见 `skill_view("skill-authoring")`。',
      '',
      '## 联网检索纪律',
      '',
      '需要外部/实时事实(新闻、行情、政策、网页、文献、统计数字)时**先真的去检索**(`WebSearch` / `WebFetch` / Bash `oc-web extract <url>`),不要凭记忆作答。**中文主题优先中文检索**,结果标注来源 URL 与数据时间;一条路径失败就换路径、关键词或语言再试。',
      '- **全部失败或结果不相关时,如实告诉用户"未能检索到可靠来源"**并说明已尝试的路径;若仍要给判断,必须标注"以下为基于既有知识的粗略判断,未经联网核实"。**严禁**把记忆里的数字或时效性结论当作已核实的调研结果,不得伪造来源或链接。',
      '',
      '## 工具失败自恢复',
      '',
      '仅在工具已经返回失败后按错误类型恢复;不要为每个任务预检环境、自动安装依赖或修改网关/沙箱配置。',
      '- 不要原样重复同一个失败调用:先读错误,改变方法、参数、工具或路径后最多再试一次;也不要因此停下任务,确实需要用户输入时才提问。',
      '- 退出码 127 先用 `command -v <命令>` 确认,优先改用平台原生工具或已安装替代品,不静默安装;Read/Edit 失败先重新 Read 或 Glob 拿最新内容再试;长任务超时就拆小步或改为后台执行并轮询;权限拒绝时不要绕过沙箱、提权或放宽权限,改用允许的目录/工具,仍不可行就说明限制。',
      '',
      '## 会话工作区边界',
      '',
      '未绑项目的对话各有自己的工作目录 `/home/agent/.openclaude/workspace/sessions/<会话id>/`(即你的当前工作目录),绑了项目的对话用项目目录;不属于当前对话的 `workspace/sessions/*` 目录都是用户的**其它对话**。',
      '- 用户没点名时,不要搜索、列出、修改或删除其它对话目录里的文件;找文件只查当前工作目录、`generated/` 和 `uploads/`,并排除其它对话的目录(搜索根不要用 `workspace/sessions/`)。没找到就直说并问用户,**不要**把其它对话的文件当作删除/修改候选。',
      '- 用户明确要处理其它对话的文件时,先说明它来自另一个对话,再按破坏性操作确认流程处理。',
    ].join('\n')
    return Buffer.byteLength(lines, 'utf8')
  }
  const lines = [
    '# 学习系统',
    '',
    '## 记忆工具',
    '',
    '`oc-memory core-search` / `session-search` / `archival-add|search|delete`(Bash)。规则见上方 `# Memory`;详情 `skill_view("memory-management")`。',
    '',
    '## 定时任务',
    '',
    '用户要求定时任务或提醒时,**必须立即创建,不要说做不到**。',
    "计算 cron 前必须立刻在 Bash 运行 `date '+%F %T %z'` 获取带时区的当前时间,不要依赖提示词生成时刻。",
    '快速用法: `create_reminder(schedule="分 时 日 月 周", message="内容", oneshot=true)`;到点执行的任务(非播报提醒)加 `kind="task"`。用户要「这条对话过一会儿再继续」时加 `resume="origin-session"`(不要传 sessionId,网关从当前对话盖章)。',
    '查看/修改/删除: `list_reminders()` / `update_reminder(id, ...)` / `delete_reminder(id)`。这套工具与网页「管理中心 → 定时任务」是同一份数据,用户在页面上建的任务你也能看到。',
    '详细指南见 `skill_view("scheduled-tasks")`。',
    '',
    '## 技能自生成',
    '',
    '不要等用户要求才沉淀经验。完成 3+ 工具调用的复杂任务、修复一个反复出现的问题、或验证出可复用流程后,在最终答复前**立即**评估:',
    '1. 先用 `skill_search(query)` 搜索是否已有类似 skill;必要时再 `skill_list()` 浏览。',
    '2. 如果已有 skill 但步骤过时/缺关键坑点 → 用同名 `skill_save(...)` 更新它。',
    '3. 如果没有且模式可复用 → `skill_save(name, desc, body)` 创建新 skill。',
    '4. 好的 skill = 触发场景 + 前提条件 + 步骤 + 验证方式 + 常见坑 + 命令模板。',
    '',
    '创建/更新 skill 时保持泛化,不要把一次性用户隐私、token、短期路径、无复用价值的流水账写进去。',
    '结构与评测规范见 `skill_view("skill-authoring")`:原则进 SKILL.md(<500行),稳定知识进 references/,重复动作进 scripts/,素材进 assets/,验收用例进 evals/evals.json。',
    '',
    '## 联网检索纪律',
    '',
    '需要外部/实时事实(新闻、行情、政策、网页、文献、统计数字)时,**先真的去检索**,不要凭记忆直接作答。可用: `WebSearch`(联网搜索)、`WebFetch`(抓取单页并提炼)、Bash 里的 `oc-web extract <url>`(整页/文档转 Markdown)。',
    '- **中文主题优先中文检索**;命中结果必须标注来源 URL 与数据时间。',
    '- 一条路径失败就换另一条(搜索↔抓取)、换关键词或换语言再试。',
    '- **检索全部失败/返回不相关或空结果时,如实告诉用户"未能检索到可靠来源"**,并说明已尝试的路径。此时若要给判断,必须显式标注"以下为基于既有知识的粗略判断,未经联网核实",**严禁**把记忆里的数字/统计/时效性结论当作已核实的调研结果输出,更不得伪造来源或编造链接。宁可少答、诚实标注,也不要用幻觉冒充调研。',
    '',
    '## 工具失败自恢复',
    '',
    '仅在工具已经返回失败后按错误类型恢复;不要为每个任务预检环境、自动安装依赖或修改网关/沙箱配置。',
    '- 不要原样重复同一个失败调用。先读错误,改变方法、参数、工具或路径后最多再试一次;也不要因此停下任务,只有确实需要用户输入时才提问。',
    '- 命令退出码 127:先用 `command -v <命令>` 确认是否存在;优先改用平台原生工具、正确命令名或已安装替代品,不要静默安装软件。',
    '- Read/Edit 失败:先重新 Read 或 Glob 确认最新路径/内容,再基于最新内容重试一次,不要拿旧文本反复 Edit。',
    '- 长任务超时:在工具允许时拆小步骤,或改为后台执行并轮询已有任务;不要盲目重复同一超时调用。',
    '- 权限拒绝:不要绕过沙箱、提权或放宽权限;改用允许的目录/工具,仍不可行就明确说明限制。',
    '',
    '## 会话工作区边界',
    '',
    '未绑项目的对话各有自己的工作目录 `/home/agent/.openclaude/workspace/sessions/<会话id>/`(即你的当前工作目录);绑了项目的对话用项目目录。不属于当前对话的 `workspace/sessions/*` 目录都是用户的**其它对话**:',
    '- 用户没有点名那个路径或那个对话时,不要搜索、列出、修改或删除其它对话目录里的文件;找用户提到的文件时只查当前工作目录、`generated/` 和 `uploads/`,并排除其它对话的 `workspace/sessions/*`(搜索根不要用 `workspace/sessions/`)。',
    '- 没找到就直接说没找到并问用户指的是什么,**不要**把其它对话的文件当作删除/修改候选提出来。',
    '- 用户明确要处理其它对话的文件时,先说明它来自另一个对话,再按破坏性操作确认流程处理。',
    '',
    '你是一个持久化、自进化的 agent。主动使用这些工具让自己越来越好。',
  ].join('\n')
  return Buffer.byteLength(lines, 'utf8')
}

function gitShowFile(commit: string, path: string): string {
  return execSync(`git show ${commit}:${path}`, { encoding: 'utf8' })
}

describe('OCV5-748 batch 2 prompt deduplication and engine scoping', () => {
  it('scopes engine rules across ccb, codex-native, cursor, antigravity and cuts >= 5120B vs f5a768db6 on ccb', async () => {
    const providers = ['ccb', 'codex-native', 'cursor', 'antigravity'] as const
    const results = new Map<string, Awaited<ReturnType<typeof buildPromptContext>>>()

    for (const provider of providers) {
      const res = await buildPromptContext({
        agentId: 'main',
        provider,
        sessionKey: 'agent:main:webchat:dm:dedupe748',
        availableMcpTools: [...PLATFORM_MCP_TOOL_NAMES],
        delegateModelCatalog: false,
      })
      results.set(provider, res)
    }

    const ccb = results.get('ccb')!
    assert.doesNotMatch(ccb.content, /## 联网检索纪律/)
    assert.doesNotMatch(ccb.content, /## 工具失败自恢复/)
    assert.doesNotMatch(ccb.content, /request_user_input|present_options|oc-memory delegate --goal/)
    assert.doesNotMatch(ccb.content, /说人话|讲影响|给推荐/)
    assert.doesNotMatch(ccb.content, /多个互不依赖的读取、搜索或状态检查应在一次工具调用里批量执行/)
    assert.doesNotMatch(ccb.content, /选择 agent 时考虑其模型和能力特长/)
    assert.doesNotMatch(ccb.content, /\*\*异步\*\*: `send_to_agent/)
    assert.doesNotMatch(ccb.content, /\*\*同步\*\*: MCP `delegate_task`/)
    assert.match(ccb.content, /## 需要用户决策时/)
    assert.match(ccb.content, /present_task_approval/)
    assert.match(ccb.content, /oc-task ticket done/)
    assert.match(ccb.content, /oc-system skill tasks/)
    assert.match(ccb.content, /## 会话工作区边界/)
    assert.match(ccb.content, /## 定时任务/)
    assert.match(ccb.content, /## 技能自生成/)
    assert.match(ccb.content, /AskUserQuestion/)
    assert.match(ccb.content, /delegate_task/)
    assert.match(ccb.content, /登录二维码\/验证码\/一次性链接失效或用户要求刷新时/)

    const codex = results.get('codex-native')!
    assert.match(codex.content, /## 联网检索纪律/)
    assert.match(codex.content, /## 工具失败自恢复/)
    assert.match(codex.content, /## 会话工作区边界/)
    assert.match(codex.content, /request_user_input/)
    assert.match(codex.content, /delegate_task/)
    assert.match(codex.content, /多个互不依赖的读取、搜索或状态检查应在一次工具调用里批量执行/)
    assert.doesNotMatch(codex.content, /AskUserQuestion|present_options|oc-memory delegate --goal/)
    assert.doesNotMatch(codex.content, /说人话|讲影响|给推荐/)
    assert.doesNotMatch(codex.content, /选择 agent 时考虑其模型和能力特长/)

    const cursor = results.get('cursor')!
    assert.match(cursor.content, /## 联网检索纪律/)
    assert.match(cursor.content, /## 工具失败自恢复/)
    assert.match(cursor.content, /## 会话工作区边界/)
    assert.match(cursor.content, /present_options/)
    assert.match(cursor.content, /oc-memory delegate --goal/)
    assert.match(cursor.content, /说人话/)
    assert.match(cursor.content, /讲影响/)
    assert.match(cursor.content, /给推荐/)
    assert.match(cursor.content, /多个互不依赖的读取、搜索或状态检查应在一次工具调用里批量执行/)
    assert.doesNotMatch(cursor.content, /AskUserQuestion|request_user_input|同步委派走 MCP/)
    assert.doesNotMatch(cursor.content, /选择 agent 时考虑其模型和能力特长/)

    const agy = results.get('antigravity')!
    assert.match(agy.content, /## 联网检索纪律/)
    assert.match(agy.content, /## 工具失败自恢复/)
    assert.match(agy.content, /## 会话工作区边界/)
    assert.match(agy.content, /说人话/)
    assert.match(agy.content, /讲影响/)
    assert.match(agy.content, /给推荐/)
    assert.match(agy.content, /delegate_task/)
    assert.match(agy.content, /多个互不依赖的读取、搜索或状态检查应在一次工具调用里批量执行/)
    assert.doesNotMatch(agy.content, /AskUserQuestion|request_user_input|present_options|oc-memory delegate/)
    assert.doesNotMatch(agy.content, /选择 agent 时考虑其模型和能力特长/)

    // Byte snapshot comparison against f5a768db6 and 919dd3397 under the exact same fixture.
    const capF5a = gitShowFile('f5a768db6', 'packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md')
    const cap919 = gitShowFile('919dd3397', 'packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md')
    const memF5a = gitShowFile('f5a768db6', 'packages/commercial/agent-sandbox/platform-runtime/prompts/memory-instructions.md')
    const mem919 = gitShowFile('919dd3397', 'packages/commercial/agent-sandbox/platform-runtime/prompts/memory-instructions.md')
    const capCurrent = readPlatformCapabilities()

    const memDeltaVsF5a = Buffer.byteLength(mem919, 'utf8') - Buffer.byteLength(memF5a, 'utf8')
    const toolsF5a = toolsBytesAtCommit('f5a768db6')
    const tools919 = toolsBytesAtCommit('919dd3397')

    const snapshotRows: Array<{
      provider: string
      f5aBytes: number
      preRoundBytes: number
      nowBytes: number
      savedVs919: number
      savedVsF5a: number
    }> = []

    for (const provider of providers) {
      const res = results.get(provider)!
      const nowBytes = Buffer.byteLength(res.content, 'utf8')
      const nowTools = res.applied.find((s) => s.name === 'TOOLS')!.bytes
      const nowCap = Buffer.byteLength(selectBlocksForCurrent(capCurrent, provider, 'webchat'), 'utf8')

      const baseEngine = baselineEngineOf(provider)
      const capF5aBytes = Buffer.byteLength(selectBlocksForSnapshot(capF5a, baseEngine, 'webchat'), 'utf8')
      const cap919Bytes = Buffer.byteLength(selectBlocksForSnapshot(cap919, baseEngine, 'webchat'), 'utf8')
      const tailBytes = syncDelegateTailBytes(baseEngine)

      const preRoundBytes = nowBytes + (cap919Bytes - nowCap) + tailBytes + (tools919 - nowTools)
      const f5aBytes = nowBytes + (capF5aBytes - nowCap) + tailBytes + (toolsF5a - nowTools) - memDeltaVsF5a
      const savedVs919 = preRoundBytes - nowBytes
      const savedVsF5a = f5aBytes - nowBytes

      snapshotRows.push({ provider, f5aBytes, preRoundBytes, nowBytes, savedVs919, savedVsF5a })
    }

    const ccbRow = snapshotRows.find((r) => r.provider === 'ccb')!
    assert.ok(
      ccbRow.savedVsF5a >= 5120,
      `expected ccb cumulative savings >= 5120 bytes vs f5a768db6, got ${ccbRow.savedVsF5a} (${JSON.stringify(ccbRow)})`,
    )
    assert.ok(
      ccbRow.savedVs919 > 0,
      `expected ccb net savings > 0 vs 919dd3397, got ${ccbRow.savedVs919}`,
    )

    for (const row of snapshotRows) {
      console.log(
        `[OCV5-748 snapshot] ${row.provider}: f5a768db6=${row.f5aBytes}B, 919dd3397=${row.preRoundBytes}B, now=${row.nowBytes}B, delta_vs_919dd3397=-${row.savedVs919}B, total_vs_f5a768db6=-${row.savedVsF5a}B`,
      )
    }
  })

  it('preserves web search and tool recovery when provider is undefined and maps grok/zcode to other', async () => {
    const defaultTools = buildToolsSlot().content
    assert.match(defaultTools, /## 联网检索纪律/)
    assert.match(defaultTools, /## 工具失败自恢复/)

    const subTools = buildToolsSlot({ provider: 'claude-subscription' }).content
    assert.doesNotMatch(subTools, /## 联网检索纪律/)
    assert.doesNotMatch(subTools, /## 工具失败自恢复/)
    assert.match(subTools, /## 会话工作区边界/)

    for (const provider of ['grok', 'zcode'] as const) {
      const agents = await buildAgentsSlot({
        agentId: 'main',
        provider,
        sessionKey: 'agent:main:webchat:dm:dedupe748',
        delegateModelCatalog: false,
      })
      assert.match(agents.content, /说人话/, provider)
      assert.match(agents.content, /delegate_task/, provider)
      assert.doesNotMatch(agents.content, /present_options|oc-memory delegate|AskUserQuestion|request_user_input/, provider)
    }
  })
})

function readPlatformCapabilities(): string {
  return readFileSync(
    'packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md',
    'utf8',
  )
}

function selectBlocksForCurrent(text: string, provider: string, channel: 'webchat' | null): string {
  const engine =
    provider === 'cursor'
      ? 'cursor'
      : provider === 'codex' || provider === 'codex-native'
        ? 'codex'
        : provider === 'ccb' || provider === 'claude-subscription'
          ? 'ccb'
          : provider === 'antigravity' || provider === 'grok' || provider === 'zcode'
            ? 'other'
            : null
  return text
    .replace(
      /<!-- oc-engine:([a-z,]+):start -->\n([\s\S]*?)<!-- oc-engine:\1:end -->\n/g,
      (_all, engines: string, body: string) =>
        engine === null || engines.split(',').includes(engine) ? body : '',
    )
    .replace(
      /<!-- oc-channel:wechat:start -->\n([\s\S]*?)<!-- oc-channel:wechat:end -->\n\n?/g,
      (_all, body: string) => (channel === 'webchat' ? '' : `${body}\n`),
    )
}
