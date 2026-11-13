import { MAX_UPLOAD_CHUNK_BYTES, MAX_UPLOAD_FILE_BYTES, UPLOAD_CHUNK_BYTES } from './uploadLimits.js'

export function uploadChunkCount(sizeBytes: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RangeError('upload size must be a positive safe integer')
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 8 * 1024 * 1024 || chunkBytes > MAX_UPLOAD_CHUNK_BYTES) {
    throw new RangeError('chunk size must be inside 8–32MiB')
  }
  if (sizeBytes > MAX_UPLOAD_FILE_BYTES) {
    throw new RangeError('upload size exceeds the assembled file cap')
  }
  return Math.ceil(sizeBytes / chunkBytes)
}

export function uploadChunkLength(sizeBytes: number, index: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  const count = uploadChunkCount(sizeBytes, chunkBytes)
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError('chunk index out of range')
  }
  const start = index * chunkBytes
  return Math.min(chunkBytes, sizeBytes - start)
}
