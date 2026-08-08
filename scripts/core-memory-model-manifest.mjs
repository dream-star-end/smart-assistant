export const CORE_MEMORY_MODEL_MANIFEST = Object.freeze({
  schemaVersion: 1,
  repository: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dtype: 'q8',
  files: Object.freeze([
    Object.freeze({
      path: 'config.json',
      bytes: 658,
      sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
    }),
    Object.freeze({
      path: 'tokenizer.json',
      bytes: 17_082_730,
      sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    }),
    Object.freeze({
      path: 'tokenizer_config.json',
      bytes: 443,
      sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
    }),
    Object.freeze({
      path: 'onnx/model_quantized.onnx',
      bytes: 118_308_185,
      sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    }),
  ]),
})

export const CORE_MEMORY_MODEL_MANIFEST_FILE = 'MODEL_MANIFEST.json'
