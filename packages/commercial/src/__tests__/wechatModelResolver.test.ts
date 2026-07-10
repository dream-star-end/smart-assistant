import { describe, test } from "node:test"
import assert from "node:assert/strict"

import {
  listWechatInboundModels,
  pickWechatInboundModel,
  pickWechatModelByUserInput,
} from "../wechat/modelResolver.js"

const allowed = new Set(["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5.6-sol"])

describe("pickWechatInboundModel", () => {
  test("uses preferred model only when gateway-compatible and authorized", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-sonnet-4-6",
      visibleModels: [{ id: "claude-opus-4-7" }],
      canUseModel: (id) => id === "claude-sonnet-4-6",
      allowedModels: allowed,
    })
    assert.equal(picked, "claude-sonnet-4-6")
  })

  test("authorized but gateway-incompatible preferred model falls back to allowed visible model", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-haiku-4-5", // canUseModel may allow it, but gateway rejects it
      visibleModels: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-4-6" }],
      canUseModel: (id) => id === "claude-haiku-4-5" || id === "claude-sonnet-4-6",
      allowedModels: allowed,
    })
    assert.equal(picked, "claude-sonnet-4-6")
  })

  test("authorized preferred model disabled/hidden from visible fallback returns null if no allowed fallback", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "unknown-model",
      visibleModels: [{ id: "claude-haiku-4-5" }],
      canUseModel: () => true,
      allowedModels: allowed,
    })
    assert.equal(picked, null)
  })

  test("unauthorized preferred model falls back to first authorized allowed visible model", () => {
    const picked = pickWechatInboundModel({
      preferredModel: "claude-opus-4-7",
      visibleModels: [{ id: "claude-opus-4-7" }, { id: "gpt-5.6-sol" }],
      canUseModel: (id) => id === "gpt-5.6-sol",
      allowedModels: allowed,
    })
    assert.equal(picked, "gpt-5.6-sol")
  })
})

describe("listWechatInboundModels", () => {
  test("filters visible models by gateway allowlist and canUseModel while preserving display names", () => {
    const models = listWechatInboundModels({
      preferredModel: undefined,
      visibleModels: [
        { id: "claude-haiku-4-5", display_name: "Haiku" },
        { id: "claude-sonnet-4-6", display_name: "Sonnet" },
        { id: "gpt-5.6-sol", displayName: "GPT 5.5" },
      ],
      canUseModel: (id) => id !== "gpt-5.6-sol",
      allowedModels: allowed,
    })
    assert.deepEqual(models, [{ id: "claude-sonnet-4-6", displayName: "Sonnet" }])
  })
})

describe("pickWechatModelByUserInput", () => {
  const models = [
    { id: "claude-opus-4-7", displayName: "Opus" },
    { id: "claude-sonnet-4-6", displayName: "Sonnet" },
  ]

  test("selects by 1-based index", () => {
    assert.equal(pickWechatModelByUserInput("2", models)?.id, "claude-sonnet-4-6")
  })

  test("selects by exact model id", () => {
    assert.equal(pickWechatModelByUserInput("claude-opus-4-7", models)?.displayName, "Opus")
  })

  test("returns null for out-of-range or unknown input", () => {
    assert.equal(pickWechatModelByUserInput("3", models), null)
    assert.equal(pickWechatModelByUserInput("claude-haiku-4-5", models), null)
  })
})
