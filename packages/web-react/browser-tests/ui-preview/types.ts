import type { ReactNode } from 'react'
export type ApiMockTable = Record<string, (...args: any[]) => Promise<any>>
export type Scene = {
  id: string                        // kebab-case, 如 'manage-memory'
  label: string                     // 中文场景名
  group: '管理中心' | '市场'
  viewports?: ('desktop' | 'mobile')[]   // 默认 ['desktop']
  api: ApiMockTable                 // 方法名 → 假实现,键名 = src/lib/api.ts 里 api 对象的方法名
  render: () => ReactNode           // 直接渲染目标组件(open 恒 true)
}
