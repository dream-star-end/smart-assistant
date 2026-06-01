/**
 * MiniMax Token Plan media pricing helpers.
 *
 * Unit: all returned costs are人民币“分”(credit_ledger/usage_records 的 cost_credits
 * 口径；1 积分 = 100 分)。Prices are the original (non-discounted) RMB prices
 * from https://platform.minimaxi.com/docs/guides/pricing-paygo as requested by boss.
 */

export type MiniMaxMediaOperation =
  | "image"
  | "speech"
  | "voice_design"
  | "voice_clone"
  | "video"
  | "music"
  | "lyrics";

export interface MiniMaxMediaPriceSnapshot {
  provider: "minimax";
  operation: MiniMaxMediaOperation;
  model: string;
  unit: string;
  unit_price_cents: string;
  quantity: string;
  cost_credits: string;
  source: string;
  captured_at: string;
  notes?: string;
}

export interface MiniMaxMediaCostResult {
  operation: MiniMaxMediaOperation;
  model: string;
  units: Record<string, unknown>;
  costCredits: bigint;
  snapshot: MiniMaxMediaPriceSnapshot;
}

const PRICE_SOURCE = "https://platform.minimaxi.com/docs/guides/pricing-paygo";

function snapshot(input: {
  operation: MiniMaxMediaOperation;
  model: string;
  unit: string;
  unitPriceCents: bigint;
  quantity: bigint;
  costCredits: bigint;
  capturedAt?: Date;
  notes?: string;
}): MiniMaxMediaPriceSnapshot {
  return {
    provider: "minimax",
    operation: input.operation,
    model: input.model,
    unit: input.unit,
    unit_price_cents: input.unitPriceCents.toString(),
    quantity: input.quantity.toString(),
    cost_credits: input.costCredits.toString(),
    source: PRICE_SOURCE,
    captured_at: (input.capturedAt ?? new Date()).toISOString(),
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

function ceilDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new TypeError("den must be positive");
  if (num <= 0n) return 0n;
  return (num + den - 1n) / den;
}

function positiveInt(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`${name} must be an integer in [1, ${max}], got ${value}`);
  }
  return value;
}

/**
 * MiniMax 语音计费字符：价格页说明“1 个汉字算 2 个字符，英文字母、希腊字母、
 * 标点、特殊符号、空格、回车等算 1 个字符”。这里按 Unicode Han script 计 2,
 * 其余 Unicode code point 计 1；这是平台预估和入账口径,上游响应若返回
 * usage_characters,media proxy 会优先使用上游值重算并入账。
 */
export function countMiniMaxSpeechCharacters(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += /\p{Script=Han}/u.test(ch) ? 2 : 1;
  }
  return total;
}

export function calculateMiniMaxImageCost(input: {
  model?: string;
  imageCount?: number;
  capturedAt?: Date;
} = {}): MiniMaxMediaCostResult {
  const model = input.model ?? "image-01";
  if (model !== "image-01" && model !== "image-01-live") {
    throw new TypeError(`unsupported MiniMax image model: ${model}`);
  }
  const imageCount = positiveInt("imageCount", input.imageCount ?? 1, 8);
  // ¥0.025/张 = 2.5 分；ledger 只能按整数分,向上取整到 3 分/张避免少扣。
  const unitPrice = 3n;
  const qty = BigInt(imageCount);
  const cost = unitPrice * qty;
  return {
    operation: "image",
    model,
    units: { image_count: imageCount, billed_unit_price_note: "¥0.025/image rounded up to 3 cents" },
    costCredits: cost,
    snapshot: snapshot({
      operation: "image",
      model,
      unit: "image",
      unitPriceCents: unitPrice,
      quantity: qty,
      costCredits: cost,
      capturedAt: input.capturedAt,
      notes: "Original price ¥0.025/image rounded up to whole cents.",
    }),
  };
}

export function calculateMiniMaxSpeechCost(input: {
  model?: string;
  text?: string;
  usageCharacters?: number;
  capturedAt?: Date;
}): MiniMaxMediaCostResult {
  const model = input.model ?? "speech-2.8-turbo";
  const unitPrice = model === "speech-2.8-turbo"
    ? 200n
    : model === "speech-2.8-hd"
      ? 350n
      : (() => { throw new TypeError(`unsupported MiniMax speech model: ${model}`); })();
  const chars = input.usageCharacters ?? countMiniMaxSpeechCharacters(input.text ?? "");
  const charCount = positiveInt("usageCharacters", chars, 1_000_000);
  const qty = ceilDiv(BigInt(charCount), 10_000n);
  const cost = qty * unitPrice;
  return {
    operation: "speech",
    model,
    units: { characters: charCount, billing_blocks_10k_chars: qty.toString() },
    costCredits: cost,
    snapshot: snapshot({
      operation: "speech",
      model,
      unit: "10k_chars",
      unitPriceCents: unitPrice,
      quantity: qty,
      costCredits: cost,
      capturedAt: input.capturedAt,
    }),
  };
}

export function calculateMiniMaxVoiceDesignCost(input: {
  operation: "voice_design" | "voice_clone";
  capturedAt?: Date;
}): MiniMaxMediaCostResult {
  // 价格页：音色设计/快速复刻 ¥9.9/音色；费用在首次使用音色合成时收取。
  // 当前 proxy 不直接开放 voice design/clone 执行,但保留 calculator 供后续接入。
  const unitPrice = 990n;
  return {
    operation: input.operation,
    model: "all",
    units: { voice_count: 1 },
    costCredits: unitPrice,
    snapshot: snapshot({
      operation: input.operation,
      model: "all",
      unit: "voice",
      unitPriceCents: unitPrice,
      quantity: 1n,
      costCredits: unitPrice,
      capturedAt: input.capturedAt,
      notes: "Billed by MiniMax when the generated/cloned voice is first used for synthesis.",
    }),
  };
}

const VIDEO_PRICE_CENTS = new Map<string, bigint>([
  ["MiniMax-Hailuo-2.3-Fast|image|768P|6", 135n],
  ["MiniMax-Hailuo-2.3-Fast|image|768P|10", 225n],
  ["MiniMax-Hailuo-2.3-Fast|image|1080P|6", 231n],
  ["MiniMax-Hailuo-2.3|text_or_image|768P|6", 200n],
  ["MiniMax-Hailuo-2.3|text_or_image|768P|10", 400n],
  ["MiniMax-Hailuo-2.3|text_or_image|1080P|6", 350n],
  ["MiniMax-Hailuo-02|text_or_image|768P|6", 200n],
  ["MiniMax-Hailuo-02|text_or_image|768P|10", 400n],
  ["MiniMax-Hailuo-02|text_or_image|1080P|6", 350n],
  ["MiniMax-Hailuo-02|image|512P|6", 60n],
  ["MiniMax-Hailuo-02|image|512P|10", 100n],
]);

export function calculateMiniMaxVideoCost(input: {
  model?: string;
  mode?: "text" | "image" | "text_or_image";
  resolution?: string;
  duration?: number;
  capturedAt?: Date;
}): MiniMaxMediaCostResult {
  const model = input.model ?? "MiniMax-Hailuo-2.3";
  const duration = positiveInt("duration", input.duration ?? 6, 10);
  const resolution = (input.resolution ?? "768P").toUpperCase();
  const mode = input.mode ?? "text_or_image";
  const normalizedMode = model === "MiniMax-Hailuo-2.3-Fast"
    ? "image"
    : model === "MiniMax-Hailuo-02" && resolution === "512P"
      ? "image"
      : "text_or_image";
  if (mode === "text" && model === "MiniMax-Hailuo-2.3-Fast") {
    throw new TypeError("MiniMax-Hailuo-2.3-Fast pricing is only defined for image-to-video");
  }
  const key = `${model}|${normalizedMode}|${resolution}|${duration}`;
  const unitPrice = VIDEO_PRICE_CENTS.get(key);
  if (unitPrice === undefined) {
    throw new TypeError(`unsupported MiniMax video price tier: ${key}`);
  }
  return {
    operation: "video",
    model,
    units: { mode, billed_mode: normalizedMode, resolution, duration_seconds: duration, video_count: 1 },
    costCredits: unitPrice,
    snapshot: snapshot({
      operation: "video",
      model,
      unit: "video",
      unitPriceCents: unitPrice,
      quantity: 1n,
      costCredits: unitPrice,
      capturedAt: input.capturedAt,
    }),
  };
}

export function calculateMiniMaxMusicCost(input: {
  model?: string;
  capturedAt?: Date;
} = {}): MiniMaxMediaCostResult {
  const model = input.model ?? "music-2.6";
  if (model !== "music-2.6" && model !== "music-cover") {
    throw new TypeError(`unsupported MiniMax music model: ${model}`);
  }
  // 价格页：Music-2.6 ¥1.0/首，当前“限免”不采用。
  const unitPrice = 100n;
  return {
    operation: "music",
    model,
    units: { song_count: 1 },
    costCredits: unitPrice,
    snapshot: snapshot({
      operation: "music",
      model,
      unit: "song",
      unitPriceCents: unitPrice,
      quantity: 1n,
      costCredits: unitPrice,
      capturedAt: input.capturedAt,
      notes: "Original price ¥1/song; temporary free promotion is intentionally ignored.",
    }),
  };
}

export function calculateMiniMaxLyricsCost(input: {
  capturedAt?: Date;
} = {}): MiniMaxMediaCostResult {
  // 价格页：歌词生成 ¥0.05/首，当前“限免”不采用。
  const unitPrice = 5n;
  return {
    operation: "lyrics",
    model: "lyrics_generation",
    units: { lyrics_count: 1 },
    costCredits: unitPrice,
    snapshot: snapshot({
      operation: "lyrics",
      model: "lyrics_generation",
      unit: "song",
      unitPriceCents: unitPrice,
      quantity: 1n,
      costCredits: unitPrice,
      capturedAt: input.capturedAt,
      notes: "Original price ¥0.05/song; temporary free promotion is intentionally ignored.",
    }),
  };
}
