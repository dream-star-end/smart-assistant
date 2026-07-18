import { KNOWLEDGE_PLANET_PLUGIN_SLUG } from './knowledgePlanetContract.js'

export interface ManagedPluginWritePolicy {
  version: number
  disclaimerText: string
}

export interface ManagedPluginWritePreapprovalPolicy {
  version: number
  disclaimerText: string
}

const KNOWLEDGE_PLANET_WRITE_POLICY: ManagedPluginWritePolicy = Object.freeze({
  version: 2,
  disclaimerText:
    '开启后，Plugin 可使用你当前登录的真实知识星球身份发布主题、评论或回复，上传图片和附件，设置点赞状态，完整替换编辑主题，以及永久删除主题、评论或回复。内容与互动会对相应星球成员可见；编辑会受上游“完整替换”语义影响，删除不可撤销。你应自行确认内容真实、合法并拥有所需权利，同时遵守知识星球及所在星球的权限、审核与平台规则，避免泄露隐私或机密信息。知识星球当前不提供可靠的评论正文编辑接口，Plugin 不会用删除后重发冒充编辑。AI 可能理解或生成错误；开启本开关只授予手动写能力，每一次操作仍须由你在对话确认卡中单独批准。上游没有条件更新版本号，编辑/删除在最终校验与写入之间仍存在极短竞态窗口。关闭后不会启动新的手动写入；已经确认并进入发送阶段的操作仍可能完成。发送结果不明确时系统不会自动重试，请先到知识星球核实，避免重复操作。',
})

const KNOWLEDGE_PLANET_WRITE_PREAPPROVAL_POLICY: ManagedPluginWritePreapprovalPolicy =
  Object.freeze({
    version: 1,
    disclaimerText:
      '开启“免逐次确认”后，当前账号下可使用知识星球 Plugin 的所有 Agent 都能直接发布主题、评论或回复，上传图片和附件，设置点赞状态，完整替换编辑主题，以及永久删除主题、评论或回复，不再逐次向你展示确认卡。该独立授权是对手动写入声明中“每次确认”默认规则的明确例外；内容和互动会立即对相应星球成员可见，删除不可撤销，编辑可能覆盖现有正文或媒体。AI 可能误解你的意图、选错目标、生成错误或不当内容，也可能在短时间内连续执行多次操作。你应确保 Agent 指令、内容、附件和目标合法合规，拥有必要权利并遵守知识星球及所在星球规则。平台仍会执行参数校验、账号锁、媒体完整性校验、编辑或删除前快照复核、加密审计和结果不明确时不自动重试，但这些保护不能替代你的逐次审阅。关闭本开关会阻止尚未开始的新免确认写入；已经进入发送阶段的操作仍可能完成。启用即表示你理解并接受免逐次确认带来的全部风险和最终责任。',
  })

/** A managed-browser Plugin may expose writes only when the platform owns a current policy. */
export function managedPluginWritePolicy(slug: string): ManagedPluginWritePolicy | null {
  return slug === KNOWLEDGE_PLANET_PLUGIN_SLUG ? KNOWLEDGE_PLANET_WRITE_POLICY : null
}

/** Independent policy for account-level removal of the per-operation confirmation card. */
export function managedPluginWritePreapprovalPolicy(
  slug: string,
): ManagedPluginWritePreapprovalPolicy | null {
  return slug === KNOWLEDGE_PLANET_PLUGIN_SLUG
    ? KNOWLEDGE_PLANET_WRITE_PREAPPROVAL_POLICY
    : null
}
