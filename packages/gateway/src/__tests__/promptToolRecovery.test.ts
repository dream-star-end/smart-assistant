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
