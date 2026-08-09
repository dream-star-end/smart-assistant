import { KNOWLEDGE_PLANET_PLUGIN_SLUG } from './knowledgePlanetContract.js'
import { WEIBO_PLUGIN_SLUG } from './weiboContract.js'
import { ZHIHU_PLUGIN_SLUG } from './zhihuContract.js'

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

const WEIBO_WRITE_POLICY: ManagedPluginWritePolicy = Object.freeze({
  version: 3,
  disclaimerText:
    '开启后，Plugin 可使用你当前登录的真实微博身份发布文字或图片微博、编辑或永久删除自己的微博、评论或回复、删除自己的评论/回复或自己微博下收到的评论、转发微博、发送私信，以及设置微博点赞、评论点赞、收藏和关注状态。这些操作会立即对微博中的相应用户可见；私信属于非公开通信，可能包含敏感信息；编辑会改变已发布内容，删除不可撤销。你应确保内容真实、合法并拥有文字和图片所需权利，遵守微博社区公约及适用法律，避免泄露隐私或机密信息。AI 可能理解错误、选错目标或生成不当内容；开启本开关只授予写入能力，默认每一次写操作仍须由你在对话确认卡中单独批准。若你另行接受独立的账号级高风险声明，可选择免逐次确认；该授权默认关闭且不会随本开关自动开启。上游网页没有条件更新版本号，最终复核与点击之间仍可能存在极短竞态窗口。验证码、风控或身份异常会立即停止，系统不会尝试绕过。关闭后不会启动新的写入；已经确认并进入发送阶段的操作仍可能完成。发送结果不明确时不会自动重试，请先到微博核实，避免重复发布、私信或互动。',
})

const WEIBO_WRITE_PREAPPROVAL_POLICY: ManagedPluginWritePreapprovalPolicy = Object.freeze({
  version: 2,
  disclaimerText:
    '开启“免逐次确认”后，当前账号下可使用微博 Plugin 的所有 Agent 都能直接发布文字或图片微博、编辑或永久删除自己的微博、发布评论或回复、删除自己的评论/回复或自己微博下收到的评论、转发微博、发送私信，以及设置微博点赞、评论点赞、收藏和关注状态，不再逐次向你展示确认卡。该独立授权是对写入声明中“默认逐次确认”规则的明确例外；发布、评论、回复、转发、私信和互动会立即作用于真实账号，私信属于非公开通信并可能包含敏感信息，编辑会改变已发布内容，删除不可撤销。AI 可能误解你的意图、选错微博、评论、会话或用户，生成错误或不当内容，也可能在短时间内连续执行多次操作。你应确保 Agent 指令、文字、图片和目标合法合规，拥有必要权利并遵守微博社区公约及适用法律。平台仍会执行参数校验、账号锁、图片完整性校验、编辑或删除前精确目标快照复核、加密审计、派发围栏，以及结果不明确时不自动重试；这些保护不能替代你的逐次审阅。验证码、风控或身份异常会立即停止，系统不会尝试绕过。关闭本开关会阻止尚未开始的新免确认写入；已经进入发送阶段的操作仍可能完成。启用即表示你理解并接受免逐次确认带来的全部风险和最终责任。',
})

const ZHIHU_WRITE_POLICY: ManagedPluginWritePolicy = Object.freeze({
  version: 1,
  disclaimerText:
    '开启后，Plugin 可通过知乎网页界面使用你当前登录的真实身份提问、回答、发布文章、编辑或永久删除自己的回答和文章、评论或回复、永久删除自己的评论，以及设置赞同、反对、收藏和关注状态。这些操作会作用于真实账号并可能立即对他人可见；编辑会改变已发布内容，删除不可撤销。该 Plugin 不是知乎官方产品，也不调用知乎开放接口；浏览器自动化可能受知乎现行服务协议或平台规则限制，你应自行确认有权使用并承担账号限制等风险。请确保内容真实、合法且拥有所需权利，避免泄露隐私或机密信息。AI 可能理解错误、选错目标或生成不当内容；开启本开关只授予写入能力，默认每一次写操作仍须由你在对话确认卡中单独批准。若你另行接受账号级高风险声明，可选择免逐次确认；该授权默认关闭且不会随本开关自动开启。编辑、删除和回复会在最终点击前复核服务端封存的目标快照；网页没有条件更新版本号，复核与点击之间仍可能存在极短竞态窗口。验证码、风控或身份异常会立即停止，系统不会尝试绕过。结果不明确时不会自动重试，请先到知乎核实，避免重复发布或互动。',
})

const ZHIHU_WRITE_PREAPPROVAL_POLICY: ManagedPluginWritePreapprovalPolicy = Object.freeze({
  version: 1,
  disclaimerText:
    '开启“免逐次确认”后，当前账号下可使用知乎 Plugin 的所有 Agent 都能直接提问、回答、发布或修改文章、发布评论或回复、永久删除自己的回答/文章/评论，以及设置赞同、反对、收藏和关注状态，不再逐次展示确认卡。内容和互动会立即作用于真实知乎账号，删除不可撤销；AI 可能误解意图、选错问题/回答/文章/评论或用户，生成错误或不当内容，也可能连续执行多次操作。该 Plugin 不是知乎官方产品，网页自动化可能受知乎现行服务协议或平台规则限制并带来账号限制风险。你应确保 Agent 指令、内容和目标合法合规且拥有必要权利。平台仍会执行参数校验、账号锁、编辑/删除/回复前精确快照复核、加密审计、派发围栏和结果不明确时不自动重试，但这些保护不能替代逐次审阅。验证码、风控或身份异常会立即停止且不会绕过。关闭本开关会阻止尚未开始的新免确认写入；已经进入发送阶段的操作仍可能完成。启用即表示你理解并接受这些风险和最终责任。',
})

/** A managed-browser Plugin may expose writes only when the platform owns a current policy. */
export function managedPluginWritePolicy(slug: string): ManagedPluginWritePolicy | null {
  if (slug === KNOWLEDGE_PLANET_PLUGIN_SLUG) return KNOWLEDGE_PLANET_WRITE_POLICY
  if (slug === WEIBO_PLUGIN_SLUG) return WEIBO_WRITE_POLICY
  if (slug === ZHIHU_PLUGIN_SLUG) return ZHIHU_WRITE_POLICY
  return null
}

/** Independent policy for account-level removal of the per-operation confirmation card. */
export function managedPluginWritePreapprovalPolicy(
  slug: string,
): ManagedPluginWritePreapprovalPolicy | null {
  if (slug === KNOWLEDGE_PLANET_PLUGIN_SLUG) return KNOWLEDGE_PLANET_WRITE_PREAPPROVAL_POLICY
  if (slug === WEIBO_PLUGIN_SLUG) return WEIBO_WRITE_PREAPPROVAL_POLICY
  if (slug === ZHIHU_PLUGIN_SLUG) return ZHIHU_WRITE_PREAPPROVAL_POLICY
  return null
}
