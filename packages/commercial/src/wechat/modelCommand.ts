import {
  listWechatInboundModels,
  pickWechatInboundModel,
  pickWechatModelByUserInput,
  type PickWechatInboundModelArgs,
  type WechatInboundModelOption,
} from "./modelResolver.js"

export interface HandleWechatModelCommandArgs extends PickWechatInboundModelArgs {
  text: string
  setDefaultModel: (modelId: string) => Promise<void>
}

export async function handleWechatModelCommand(
  args: HandleWechatModelCommandArgs,
): Promise<string> {
  const models = listWechatInboundModels(args)
  if (models.length === 0) {
    return "当前没有可在微信里使用的模型。请在网页端检查账号权限，或联系管理员。"
  }

  const currentModelId = pickWechatInboundModel(args)
  const selection = parseModelCommandSelection(args.text)
  if (!selection) {
    return renderWechatModelList(models, currentModelId)
  }

  const selected = pickWechatModelByUserInput(selection, models)
  if (!selected) {
    return [
      `没有找到可用模型: ${selection}`,
      "发送 /model 查看当前微信可用模型列表。",
    ].join("\n")
  }

  await args.setDefaultModel(selected.id)
  return [
    `已切换默认模型为: ${selected.displayName}`,
    `模型ID: ${selected.id}`,
    "下一条微信消息会使用这个模型；网页端默认模型也已同步更新。",
  ].join("\n")
}

export function parseModelCommandSelection(text: string): string | null {
  const m = /^\s*\/model(?:\s+(.+?))?\s*$/i.exec(text)
  const raw = m?.[1]?.trim() ?? ""
  return raw.length > 0 ? raw : null
}

export function renderWechatModelList(
  models: readonly WechatInboundModelOption[],
  currentModelId: string | null,
): string {
  const lines = [
    "当前微信可用模型:",
    ...models.map((model, idx) => {
      const marker = model.id === currentModelId ? "（当前）" : ""
      return `${idx + 1}. ${model.displayName}${marker}\n   ${model.id}`
    }),
    "",
    "发送 /model 2 或 /model <模型ID> 可切换；网页端默认模型会同步更新。",
  ]
  return lines.join("\n")
}
