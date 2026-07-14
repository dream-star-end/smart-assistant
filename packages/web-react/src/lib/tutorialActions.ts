import type { ProductCapability, ProductRequirement } from './productCapabilities'
import type { OrgRole } from './types'

export type TutorialActionContext = {
  authenticated: boolean
  featureImage2: boolean
  microphone: boolean
  orgRole?: OrgRole | null
}

export type TutorialActionState = {
  enabled: boolean
  label: string
  disabledReason?: string
}

function destinationLabel(feature: ProductCapability): string {
  switch (feature.destination.kind) {
    case 'new-chat':
      return '新建会话试一试'
    case 'focus':
      return '回到功能位置'
    case 'agent-picker':
      return '打开智能体选择'
    case 'settings':
      return '打开设置'
    case 'manage':
      return '打开管理中心'
    case 'market':
      return '打开 AI 市场'
    case 'inbox':
      return '打开站内信'
    case 'github':
      return '连接 GitHub'
    case 'org':
      return '打开组织中心'
  }
}

function requirementFailure(
  requirement: ProductRequirement,
  context: TutorialActionContext,
): string | null {
  switch (requirement) {
    case 'authenticated':
      return context.authenticated ? null : '登录后即可进入这个功能。'
    case 'image2':
      return context.featureImage2 ? null : '请先切换到支持 Image 2 的 GPT 模型。'
    case 'microphone':
      return context.microphone ? null : '当前浏览器或设备没有开放麦克风能力。'
    case 'org-manager':
      return context.orgRole === 'owner' || context.orgRole === 'admin'
        ? null
        : '只有组织拥有者或管理员可以进入这个管理分区。'
  }
}

/** 教程 CTA 的可用性单一收口。不可用时教程保持打开并解释原因。 */
export function resolveTutorialAction(
  feature: ProductCapability,
  context: TutorialActionContext,
): TutorialActionState {
  for (const requirement of feature.requirements) {
    const failure = requirementFailure(requirement, context)
    if (failure)
      return { enabled: false, label: destinationLabel(feature), disabledReason: failure }
  }
  return { enabled: true, label: destinationLabel(feature) }
}
