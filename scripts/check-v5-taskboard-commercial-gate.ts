#!/usr/bin/env tsx
/**
 * Deploy-gate contract for INC-20260906-COMMERCIAL-TASKBOARD-DIGEST.
 *
 * 商业版只用 VITE_TASKBOARD_ENABLED=0 隐藏了任务面板 UI,容器 gateway 的 PatrolEngine +
 * TaskboardNotifier 却无条件启动:新容器第一次 60s tick 就补发"昨天的简报",每个用户
 * (含刚注册 1 分钟的)都收到一条 "任务面板每日简报(0/0/0)" 站内信。
 *
 * 本门钉死三层:
 *   1. gateway server.ts 的巡检/通知启动包在 isTaskboardEnabled() 内;
 *   2. master 两条容器 provision 路径(v3supervisor / supervisor)都 spread taskboardContainerEnv();
 *      taskboardContainerEnv 对 commercial flavor 与 flavor 判定失败均输出 OC_TASKBOARD_ENABLED=0;
 *   3. 简报在空面板(无任何票)时不发送(sendDigestForDate 先查 boardHasTickets)。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

const server = read('packages/gateway/src/server.ts')
const feature = read('packages/gateway/src/taskboard/feature.ts')
const notify = read('packages/gateway/src/taskboard/notify.ts')
const taskboardEnv = read('packages/commercial/src/agent-sandbox/taskboardEnv.ts')
const v3sup = read('packages/commercial/src/agent-sandbox/v3supervisor.ts')
const sup = read('packages/commercial/src/agent-sandbox/supervisor.ts')

// 1. gateway 开关
assert.match(feature, /export function taskboardEnabledFromEnv\(raw: string \| undefined\): boolean \{\n  return raw !== '0'/)
assert.match(server, /import \{ isTaskboardEnabled \} from '\.\/taskboard\/feature\.js'/)
const gateAt = server.indexOf('if (isTaskboardEnabled()) {')
assert.ok(gateAt > 0, 'server.ts must gate taskboard automation with isTaskboardEnabled()')
for (const needle of ['new TaskboardNotifier(', 'new PatrolEngine(', 'this._taskboardTickTimer = setInterval(']) {
  const at = server.indexOf(needle)
  assert.ok(at > gateAt, `${needle} must come after the isTaskboardEnabled gate`)
  assert.equal(server.split(needle).length - 1, 1, `${needle} must be wired exactly once`)
}

// 2. master 注入
assert.match(taskboardEnv, /if \(identity\.status === ["']ok["'] && identity\.flavor === ["']commercial["']\) \{\n    return \[`\$\{TASKBOARD_ENABLED_ENV\}=0`\]/)
assert.match(taskboardEnv, /if \(err instanceof FlavorIdentityError\) return \[`\$\{TASKBOARD_ENABLED_ENV\}=0`\]/)
assert.match(taskboardEnv, /export const TASKBOARD_ENABLED_ENV = ["']OC_TASKBOARD_ENABLED["']/)
assert.match(v3sup, /\.\.\.taskboardContainerEnv\(\),/)
assert.match(sup, /env\.push\(\.\.\.taskboardContainerEnv\(\)\)/)

// 3. 空面板守卫
assert.match(notify, /if \(!boardHasTickets\(db\)\) return\n    const stats = collectDigestStats\(db, date, this\.timezone\)/)
assert.match(notify, /export function boardHasTickets\(db: TaskboardDb\): boolean/)

console.log('[taskboard-commercial-gate] PASS — commercial containers get OC_TASKBOARD_ENABLED=0, gateway gates patrol/digest on it, empty boards never emit a digest')
