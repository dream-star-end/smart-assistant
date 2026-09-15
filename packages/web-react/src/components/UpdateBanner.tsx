import { RefreshCw } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { appUpdate } from '../lib/appUpdate'
import { Alert, Button } from './ui'

/**
 * 版本更新横幅(版本握手的**非自动**出口)。只在 reload governor 判定"不能/不宜
 * 自动软刷"时出现:该目标已自动刷过一次仍不匹配(G1)、storage 不可用(G3)、
 * 或更新挂起超时(用户一直在忙,G4)。「立即刷新」走 governor.reloadNow()(保留
 * G1/G2 记账);「稍后」按目标记忆,不再打扰。自动软刷成功的用户永远看不到它。
 */
export function UpdateBanner() {
  const visible = useSyncExternalStore(appUpdate.subscribe, appUpdate.getBannerVisible)
  if (!visible) return null
  // 两个动作放进 Alert 的 action 槽(原语负责窄屏换行与右对齐)并走 Button 原语
  // (触控靶 / 焦点环),不再手写裸 <button>;文案标点用全角(shell 审计 S-13)。
  return (
    <div className="mx-auto mb-2 max-w-3xl px-4">
      <Alert
        tone="info"
        icon={<RefreshCw size={16} />}
        action={
          <>
            <Button size="sm" variant="ghost" onClick={() => appUpdate.dismissBanner()}>
              稍后
            </Button>
            <Button size="sm" variant="link" onClick={() => appUpdate.reloadNow()}>
              立即刷新
            </Button>
          </>
        }
      >
        新版本已就绪，刷新页面即可更新。
      </Alert>
    </div>
  )
}
