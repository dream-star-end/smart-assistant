import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildToolsSlot } from '../promptSlots.js'

describe('TOOLS slot failure recovery guidance', () => {
  test('guides bounded recovery without blanket preflight, installs, or permission bypass', () => {
    const content = buildToolsSlot().content
    assert.match(content, /仅在工具已经返回失败后/)
    assert.match(content, /不要原样重复同一个失败调用/)
    assert.match(content, /退出码 127.*command -v/)
    assert.match(content, /Read\/Edit 失败.*重新 Read 或 Glob/)
    assert.match(content, /长任务超时.*后台执行并轮询/)
    assert.match(content, /权限拒绝.*不要绕过沙箱、提权或放宽权限/)
    assert.match(content, /不要为每个任务预检环境、自动安装依赖或修改网关\/沙箱配置/)
  })
})

describe('TOOLS slot session workspace boundary (#1238)', () => {
  test('keeps file search/deletion inside the current conversation unless the user names another one', () => {
    const content = buildToolsSlot().content
    assert.match(content, /## 会话工作区边界/)
    assert.match(content, /不属于当前对话的 `workspace\/sessions\/\*` 目录都是用户的\*\*其它对话\*\*/)
    assert.match(content, /只查当前工作目录、`generated\/` 和 `uploads\/`,并排除其它对话的/)
    assert.match(content, /搜索根不要用 `workspace\/sessions\/`/)
    assert.match(content, /\*\*不要\*\*把其它对话的文件当作删除\/修改候选/)
    assert.match(content, /先说明它来自另一个对话/)
  })
})
