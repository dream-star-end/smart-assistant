/**
 * Intelligent UI(OCV5-361)开关关闭时的同一段对话:```ui 组件按等价 Markdown 显示(不是原始 JSON)。
 */
import { useLayoutEffect, useState } from 'react'
import { __resetIntelligentUiForTests } from '../../src/lib/intelligentUi'
import { conversation, IUI_LAPTOPS, IUI_ROAST, Timeline } from './scenes-iui'
import type { Scene } from './types'

/** 同一页面会依次挂载多个场景:只在本场景挂载期间关闭(不写 localStorage),卸载时恢复默认开。 */
function Off({ question, answer }: { question: string; answer: string }) {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    __resetIntelligentUiForTests({ pref: false, available: true })
    setReady(true)
    return () => __resetIntelligentUiForTests()
  }, [])
  return ready ? <Timeline messages={conversation(question, answer)} /> : null
}

export const iuiOffScenes: Scene[] = [
  {
    id: "iui-off-roast",
    label: "Intelligent UI 关闭 · 周日烤羊腿",
    group: "工作区",
    viewports: ["mobile", "desktop"],
    api: {},
    render: () => <Off question="周日请朋友来家里吃烤羊腿,人数还没定,帮我做个方案" answer={IUI_ROAST} />,
  },
  {
    id: "iui-off-laptops",
    label: "Intelligent UI 关闭 · 笔记本对比",
    group: "工作区",
    viewports: ["mobile", "desktop"],
    api: {},
    render: () => <Off question="出差多、主要写代码,1.5 万内买哪台笔记本?" answer={IUI_LAPTOPS} />,
  },
]
